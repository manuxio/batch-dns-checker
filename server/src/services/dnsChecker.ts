import { Resolver } from 'node:dns/promises';
import { config } from '../config';
import {
  buildZoneCandidates,
  getRegistrableDomain,
  normalizeHostname,
} from '../utils/domain';
import type {
  CheckRow,
  HostResult,
  MatchMode,
  NsAnswer,
  RecordType,
} from '../types';

/**
 * Core DNS verification logic.
 *
 * For each expectation we:
 *  1. locate the closest zone cut and read its authoritative NS set,
 *  2. resolve each NS hostname to an IP,
 *  3. query EACH authoritative NS directly for the record,
 *  4. compare the answer to the expected value (contains-match, warn on extras),
 *  5. aggregate into an overall status for the host.
 */

/** DNS error codes that represent a definitive "no such record" answer. */
const NEGATIVE_CODES = new Set(['ENODATA', 'ENOTFOUND', 'NXDOMAIN']);

/** Transient DNS error codes worth retrying with backoff. */
const RETRYABLE_CODES = new Set([
  'ETIMEOUT',
  'ETIMEDOUT',
  'ECONNREFUSED',
  'ECONNRESET',
  'ESERVFAIL',
  'EREFUSED',
  'EAI_AGAIN',
  'ENOMEM',
]);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Backoff for a given retry number (1-based); the last entry repeats. */
function backoffForRetry(retry: number): number {
  const table = config.dnsBackoffMs;
  return table[Math.min(retry - 1, table.length - 1)];
}

/**
 * Runs a DNS operation, retrying transient resolution errors up to
 * `dnsMaxRetries` times with the configured backoff (default 100ms, 500ms, 1s,
 * 2s, then 2s for any further retries). Definitive negatives (NXDOMAIN/NODATA)
 * are surfaced immediately without retrying.
 */
async function withRetry<T>(operation: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= config.dnsMaxRetries; attempt += 1) {
    try {
      return await operation();
    } catch (err) {
      lastError = err;
      const code = (err as NodeJS.ErrnoException).code ?? '';
      if (!RETRYABLE_CODES.has(code) || attempt === config.dnsMaxRetries) {
        throw err;
      }
      await sleep(backoffForRetry(attempt + 1));
    }
  }
  throw lastError;
}

/** A default (recursive) resolver used for discovery queries (NS, NS IPs). */
function createDefaultResolver(): Resolver {
  return new Resolver({ timeout: config.dnsTimeoutMs, tries: config.dnsTries });
}

/** A resolver pinned to a single authoritative nameserver IP. */
function createPinnedResolver(ip: string): Resolver {
  const resolver = new Resolver({
    timeout: config.dnsTimeoutMs,
    tries: config.dnsTries,
  });
  resolver.setServers([ip]);
  return resolver;
}

/**
 * Per-batch cache so repeated lookups (many hosts share a zone / NS) are cheap.
 */
export interface DnsCache {
  zones: Map<string, string[]>; // candidate name -> NS names (possibly empty)
  nsIps: Map<string, string[]>; // NS name -> IP addresses
}

export function createDnsCache(): DnsCache {
  return { zones: new Map(), nsIps: new Map() };
}

async function lookupNs(
  resolver: Resolver,
  name: string,
  cache: DnsCache,
): Promise<string[]> {
  const cached = cache.zones.get(name);
  if (cached) return cached;
  try {
    const ns = (await withRetry(() => resolver.resolveNs(name))).map(
      normalizeHostname,
    );
    cache.zones.set(name, ns);
    return ns;
  } catch {
    cache.zones.set(name, []);
    return [];
  }
}

/**
 * Finds the authoritative nameservers for a hostname by walking from the most
 * specific candidate zone down to the registrable domain and returning the
 * first (deepest) name that owns NS records.
 */
async function findAuthoritativeNameservers(
  hostname: string,
  resolver: Resolver,
  cache: DnsCache,
): Promise<{ zone: string | null; nameservers: string[] }> {
  const candidates = buildZoneCandidates(hostname);
  for (const candidate of candidates) {
    const ns = await lookupNs(resolver, candidate, cache);
    if (ns.length > 0) {
      return { zone: candidate, nameservers: ns };
    }
  }
  return { zone: null, nameservers: [] };
}

async function resolveNsIps(
  resolver: Resolver,
  nsName: string,
  cache: DnsCache,
): Promise<string[]> {
  const cached = cache.nsIps.get(nsName);
  if (cached) return cached;
  const ips: string[] = [];
  try {
    ips.push(...(await withRetry(() => resolver.resolve4(nsName))));
  } catch {
    /* no A records */
  }
  try {
    ips.push(...(await withRetry(() => resolver.resolve6(nsName))));
  } catch {
    /* no AAAA records */
  }
  cache.nsIps.set(nsName, ips);
  return ips;
}

/** Strips surrounding quotes and collapses internal whitespace for TXT/CAA. */
function unquote(value: string): string {
  return value.trim().replace(/^"(.*)"$/s, '$1');
}

/**
 * Policy record types are TXT records published at a conventional name with a
 * recognizable marker. Modelling them as first-class types lets users select
 * "DMARC" instead of remembering "_dmarc.<domain>" + the marker prefix, and
 * keeps the comparison focused only on the relevant TXT record.
 */
interface PolicyType {
  /** Label prefix prepended to the hostname (empty = query the host as-is). */
  prefix: string;
  /** Lower-cased marker identifying the relevant TXT record. */
  marker: string;
}

const POLICY_TYPES: Partial<Record<RecordType, PolicyType>> = {
  SPF: { prefix: '', marker: 'v=spf1' },
  DKIM: { prefix: '', marker: 'v=dkim1' }, // full selector name goes in hostname
  DMARC: { prefix: '_dmarc', marker: 'v=dmarc1' },
  MTASTS: { prefix: '_mta-sts', marker: 'v=stsv1' },
  TLSRPT: { prefix: '_smtp._tls', marker: 'v=tlsrptv1' },
  BIMI: { prefix: 'default._bimi', marker: 'v=bimi1' },
};

export function isPolicyType(type: RecordType): boolean {
  return type in POLICY_TYPES;
}

/** Resolves the actual FQDN to query for a (possibly policy) record type. */
export function resolveQueryName(type: RecordType, hostname: string): string {
  const policy = POLICY_TYPES[type];
  if (policy && policy.prefix) {
    // Don't double-prefix if the user already supplied the full name.
    if (hostname === policy.prefix || hostname.startsWith(`${policy.prefix}.`)) {
      return hostname;
    }
    return `${policy.prefix}.${hostname}`;
  }
  return hostname;
}

/** Normalizes the user-provided expected value for a given record type. */
export function normalizeExpected(type: RecordType, rawValue: string): string {
  const value = rawValue.trim();
  if (isPolicyType(type)) return unquote(value); // policy records are TXT
  switch (type) {
    case 'A':
    case 'AAAA':
      return value.toLowerCase();
    case 'CNAME':
    case 'NS':
      return normalizeHostname(value);
    case 'MX': {
      // "10 mail.example.com" or just "mail.example.com"
      const parts = value.split(/\s+/);
      if (parts.length >= 2) {
        const [priority, ...rest] = parts;
        return `${priority} ${normalizeHostname(rest.join(' '))}`;
      }
      return normalizeHostname(value);
    }
    case 'SRV': {
      // "priority weight port target"
      const parts = value.split(/\s+/);
      if (parts.length >= 4) {
        const [priority, weight, port, ...target] = parts;
        return `${priority} ${weight} ${port} ${normalizeHostname(target.join(' '))}`;
      }
      return value.toLowerCase();
    }
    case 'CAA': {
      // "flags tag value" e.g. 0 issue "letsencrypt.org"
      const match = value.match(/^(\d+)\s+(\w+)\s+(.+)$/);
      if (match) {
        return `${match[1]} ${match[2].toLowerCase()} ${unquote(match[3])}`;
      }
      return value.toLowerCase();
    }
    case 'TXT':
      return unquote(value);
    default:
      return value;
  }
}

/** Queries one record type at a pinned resolver and returns normalized values. */
async function queryRecord(
  resolver: Resolver,
  hostname: string,
  type: RecordType,
): Promise<string[]> {
  const policy = POLICY_TYPES[type];
  if (policy) {
    // Policy records are TXT; keep only the TXT matching the policy marker so
    // unrelated TXT records at the same name aren't treated as extras.
    const txts = (await resolver.resolveTxt(hostname)).map((chunks) =>
      unquote(chunks.join('')),
    );
    return txts.filter((t) => t.trim().toLowerCase().startsWith(policy.marker));
  }
  switch (type) {
    case 'A':
      return (await resolver.resolve4(hostname)).map((v) => v.toLowerCase());
    case 'AAAA':
      return (await resolver.resolve6(hostname)).map((v) => v.toLowerCase());
    case 'CNAME':
      return (await resolver.resolveCname(hostname)).map(normalizeHostname);
    case 'NS':
      return (await resolver.resolveNs(hostname)).map(normalizeHostname);
    case 'MX':
      return (await resolver.resolveMx(hostname)).map(
        (r) => `${r.priority} ${normalizeHostname(r.exchange)}`,
      );
    case 'TXT':
      return (await resolver.resolveTxt(hostname)).map((chunks) =>
        unquote(chunks.join('')),
      );
    case 'SRV':
      return (await resolver.resolveSrv(hostname)).map(
        (r) =>
          `${r.priority} ${r.weight} ${r.port} ${normalizeHostname(r.name)}`,
      );
    case 'CAA':
      return (await resolver.resolveCaa(hostname)).map((r) => {
        const flags = r.critical ?? 0;
        if (r.issue !== undefined) return `${flags} issue ${r.issue}`;
        if (r.issuewild !== undefined) return `${flags} issuewild ${r.issuewild}`;
        if (r.iodef !== undefined) return `${flags} iodef ${r.iodef}`;
        return `${flags} ${JSON.stringify(r)}`;
      });
    default:
      return [];
  }
}

/** True when the expected value is satisfied by an MX query without priority. */
function mxMatchesWithoutPriority(expected: string, returned: string[]): boolean {
  if (expected.includes(' ')) return false; // expectation includes a priority
  return returned.some((r) => r.split(/\s+/).slice(1).join(' ') === expected);
}

/** A (possibly compound) expectation parsed from the expected value cell. */
export interface Expectation {
  mode: MatchMode;
  /** Normalized expected values (per record type). */
  values: string[];
  /** Original raw expression, kept for display/export. */
  raw: string;
}

/** Detects a value that mixes both operators (ambiguous, treated as invalid). */
export function hasMixedOperators(rawValue: string): boolean {
  return /\s&\s/.test(rawValue) && /\s\|\s/.test(rawValue);
}

/**
 * Parses a (possibly compound) expected value into an Expectation:
 *  - "a & b" -> mode 'all'  (every listed value must be present)
 *  - "a | b" -> mode 'any'  (at least one present AND no value outside the set)
 *  - "a"     -> mode 'single'
 * Operators are recognized only when surrounded by whitespace, so a literal
 * "a&b" (e.g. inside a TXT record) stays a single value.
 */
export function parseExpectation(
  type: RecordType,
  rawValue: string,
): Expectation {
  const raw = rawValue.trim();
  const hasAnd = /\s&\s/.test(raw);
  const hasOr = /\s\|\s/.test(raw);

  let mode: MatchMode = 'single';
  let parts = [raw];
  if (hasAnd && !hasOr) {
    mode = 'all';
    parts = raw.split(/\s+&\s+/);
  } else if (hasOr && !hasAnd) {
    mode = 'any';
    parts = raw.split(/\s+\|\s+/);
  }

  const values = parts
    .map((part) => normalizeExpected(type, part))
    .filter((value) => value.length > 0);

  return { mode, values, raw };
}

/** True when an expected value is satisfied by the returned set. */
function valueSatisfied(expectedValue: string, returned: string[]): boolean {
  return (
    returned.includes(expectedValue) ||
    mxMatchesWithoutPriority(expectedValue, returned)
  );
}

/** True when a returned value is one of the allowed expected values. */
function isReturnedAllowed(returnedValue: string, allowed: string[]): boolean {
  if (allowed.includes(returnedValue)) return true;
  // MX: an expected host-only value allows a returned "<priority> host".
  return allowed.some(
    (a) =>
      !a.includes(' ') && returnedValue.split(/\s+/).slice(1).join(' ') === a,
  );
}

interface MatchOutcome {
  matched: boolean;
  /** Returned values outside the expectation (warnings for single/all). */
  extraValues: string[];
}

/** Evaluates the values returned by one nameserver against the expectation. */
function evaluateMatch(exp: Expectation, returned: string[]): MatchOutcome {
  const extras = returned.filter((v) => !isReturnedAllowed(v, exp.values));

  switch (exp.mode) {
    case 'all': {
      // Every listed value must be present; extra records are warnings.
      const matched = exp.values.every((v) => valueSatisfied(v, returned));
      return { matched, extraValues: matched ? extras : [] };
    }
    case 'any': {
      // At least one listed value present AND no value outside the listed set.
      const present = exp.values.some((v) => valueSatisfied(v, returned));
      const matched = present && extras.length === 0;
      return { matched, extraValues: [] };
    }
    default: {
      const matched = valueSatisfied(exp.values[0], returned);
      return { matched, extraValues: matched ? extras : [] };
    }
  }
}

interface SingleNsResult {
  status: NsAnswer['status'];
  returnedValues: string[];
  extraValues: string[];
  error?: string;
}

async function checkAgainstNs(
  ip: string,
  hostname: string,
  type: RecordType,
  expectation: Expectation,
): Promise<SingleNsResult> {
  const resolver = createPinnedResolver(ip);
  try {
    const returnedValues = await withRetry(() =>
      queryRecord(resolver, hostname, type),
    );
    const { matched, extraValues } = evaluateMatch(expectation, returnedValues);
    return {
      status: matched ? 'ok' : 'mismatch',
      returnedValues,
      extraValues,
    };
  } catch (err) {
    const error = err as NodeJS.ErrnoException;
    const code = error.code ?? '';
    // A definitive "no such record" is a mismatch, not an infrastructure error.
    if (NEGATIVE_CODES.has(code)) {
      return { status: 'mismatch', returnedValues: [], extraValues: [] };
    }
    const isTimeout = code === 'ETIMEOUT' || code === 'ETIMEDOUT';
    return {
      status: isTimeout ? 'timeout' : 'error',
      returnedValues: [],
      extraValues: [],
      error: code || error.message,
    };
  }
}

/** Runs a full check for a single expectation across all authoritative NS. */
export async function checkHost(
  row: CheckRow,
  cache: DnsCache,
): Promise<HostResult> {
  const inputHostname = normalizeHostname(row.hostname);
  const registrableDomain = getRegistrableDomain(inputHostname);
  const expectation = parseExpectation(row.type, row.expectedValue);
  // Policy types (DMARC, MTA-STS, ...) are queried at a conventional sub-name.
  const queryName = resolveQueryName(row.type, inputHostname);
  const defaultResolver = createDefaultResolver();

  const base: HostResult = {
    hostname: inputHostname,
    queryName,
    registrableDomain,
    type: row.type,
    expectedValue: row.expectedValue.trim(),
    matchMode: expectation.mode,
    zone: null,
    authoritativeNameservers: [],
    nsAnswers: [],
    status: 'error',
    warnings: [],
  };

  const { zone, nameservers } = await findAuthoritativeNameservers(
    queryName,
    defaultResolver,
    cache,
  );
  base.zone = zone;
  base.authoritativeNameservers = nameservers;

  if (nameservers.length === 0) {
    base.status = 'error';
    base.message = 'noAuthoritativeNameservers';
    return base;
  }

  const nsAnswers: NsAnswer[] = [];
  for (const nsName of nameservers) {
    const ips = await resolveNsIps(defaultResolver, nsName, cache);
    if (ips.length === 0) {
      nsAnswers.push({
        nsName,
        nsIp: null,
        status: 'error',
        returnedValues: [],
        extraValues: [],
        error: 'nsIpResolutionFailed',
      });
      continue;
    }
    // Query the first reachable IP for this nameserver.
    const result = await checkAgainstNs(ips[0], queryName, row.type, expectation);
    nsAnswers.push({
      nsName,
      nsIp: ips[0],
      status: result.status,
      returnedValues: result.returnedValues,
      extraValues: result.extraValues,
      error: result.error,
    });
  }

  base.nsAnswers = nsAnswers;
  return aggregate(base);
}

/** Combines per-NS answers into the overall host status + warnings. */
function aggregate(result: HostResult): HostResult {
  const { nsAnswers } = result;
  const warnings: string[] = [];

  const failed = nsAnswers.filter(
    (a) => a.status === 'error' || a.status === 'timeout',
  );
  const mismatched = nsAnswers.filter((a) => a.status === 'mismatch');
  const ok = nsAnswers.filter((a) => a.status === 'ok');
  const withExtras = ok.filter((a) => a.extraValues.length > 0);

  if (failed.length > 0) {
    warnings.push('someNameserversUnreachable');
  }
  if (withExtras.length > 0) {
    warnings.push('extraRecordsPresent');
  }
  // Inconsistency: some NS satisfy the expectation, others do not.
  if (ok.length > 0 && (mismatched.length > 0 || failed.length > 0)) {
    warnings.push('inconsistentAcrossNameservers');
  }

  result.warnings = warnings;

  if (failed.length > 0 || mismatched.length > 0) {
    result.status = 'error';
  } else if (ok.length === nsAnswers.length && withExtras.length > 0) {
    result.status = 'warning';
  } else if (ok.length === nsAnswers.length) {
    result.status = 'ok';
  } else {
    result.status = 'error';
  }

  return result;
}
