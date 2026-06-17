import { getRegistrableDomain, normalizeHostname } from '../utils/domain';
import { withRetry } from '../utils/retry';
import { dnsQuery, type DnsRecord } from './dnsClient';
import {
  createResolveCache,
  findAuthoritativeServers,
  type ResolveCache,
} from './iterativeResolver';
import type {
  CheckRow,
  HostResult,
  MatchMode,
  NsAnswer,
  RecordType,
} from '../types';

/**
 * Core DNS verification logic for a compliance checker.
 *
 * For each expectation we:
 *  1. start from the root servers and follow the delegation chain to find the
 *     domain's authoritative nameservers (root -> TLD -> domain),
 *  2. query EACH authoritative nameserver DIRECTLY (recursion disabled), so the
 *     answer is the freshest possible and never served from a recursive cache,
 *  3. compare the answer to the expected value (contains / AND / OR semantics),
 *  4. aggregate into an overall status for the host.
 */

// Re-export the per-batch cache under the name callers already use.
export type DnsCache = ResolveCache;
export function createDnsCache(): DnsCache {
  return createResolveCache();
}

/** Strips surrounding quotes for TXT/CAA values. */
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

/** The DNS wire type actually queried (policy types are TXT under the hood). */
function wireType(type: RecordType): string {
  return POLICY_TYPES[type] ? 'TXT' : type;
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

/** Joins the (possibly chunked) data of a TXT record into a single string. */
function txtToString(data: unknown): string {
  if (Array.isArray(data)) {
    return data
      .map((d) => (Buffer.isBuffer(d) ? d.toString('utf8') : String(d)))
      .join('');
  }
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  return String(data);
}

/** Normalizes one returned wire record into the comparable string form. */
function normalizeAnswer(type: RecordType, data: unknown): string {
  switch (type) {
    case 'A':
    case 'AAAA':
      return String(data).toLowerCase();
    case 'CNAME':
    case 'NS':
      return normalizeHostname(String(data));
    case 'MX': {
      const d = data as { preference: number; exchange: string };
      return `${d.preference} ${normalizeHostname(String(d.exchange))}`;
    }
    case 'SRV': {
      const d = data as {
        priority: number;
        weight: number;
        port: number;
        target: string;
      };
      return `${d.priority} ${d.weight} ${d.port} ${normalizeHostname(String(d.target))}`;
    }
    case 'CAA': {
      const d = data as { flags?: number; tag: string; value: string };
      return `${d.flags ?? 0} ${String(d.tag).toLowerCase()} ${unquote(String(d.value))}`;
    }
    case 'TXT':
      return unquote(txtToString(data));
    default:
      return String(data);
  }
}

/** Extracts and normalizes the returned values of the requested type. */
function extractValues(type: RecordType, answers: DnsRecord[]): string[] {
  const policy = POLICY_TYPES[type];
  if (policy) {
    return answers
      .filter((r) => r.type === 'TXT')
      .map((r) => unquote(txtToString(r.data)))
      .filter((t) => t.trim().toLowerCase().startsWith(policy.marker));
  }
  return answers
    .filter((r) => r.type === type)
    .map((r) => normalizeAnswer(type, r.data));
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
  nsIp: string | null;
  returnedValues: string[];
  extraValues: string[];
  error?: string;
}

/** Queries one authoritative nameserver directly (RD=0) and compares. */
async function querySingleIp(
  ip: string,
  queryName: string,
  type: RecordType,
  expectation: Expectation,
): Promise<SingleNsResult> {
  try {
    const response = await withRetry(() => dnsQuery(ip, queryName, wireType(type)));
    if (response.rcode !== 'NOERROR' && response.rcode !== 'NXDOMAIN') {
      // SERVFAIL / REFUSED / ... : the server could not answer authoritatively.
      return {
        status: 'error',
        nsIp: ip,
        returnedValues: [],
        extraValues: [],
        error: response.rcode,
      };
    }
    // NXDOMAIN / NODATA -> empty -> handled as a mismatch by evaluateMatch.
    const returnedValues = extractValues(type, response.answers);
    const { matched, extraValues } = evaluateMatch(expectation, returnedValues);
    return {
      status: matched ? 'ok' : 'mismatch',
      nsIp: ip,
      returnedValues,
      extraValues,
    };
  } catch (err) {
    const error = err as NodeJS.ErrnoException;
    const code = error.code ?? '';
    const isTimeout = code === 'ETIMEOUT' || code === 'ETIMEDOUT';
    return {
      status: isTimeout ? 'timeout' : 'error',
      nsIp: ip,
      returnedValues: [],
      extraValues: [],
      error: code || error.message,
    };
  }
}

/**
 * Queries a nameserver, trying its IPs in order (IPv4 first) until one answers,
 * so an unreachable IPv6 address falls through to a working IPv4 one.
 */
async function checkAgainstNs(
  ips: string[],
  queryName: string,
  type: RecordType,
  expectation: Expectation,
): Promise<SingleNsResult> {
  let last: SingleNsResult | null = null;
  for (const ip of ips) {
    const result = await querySingleIp(ip, queryName, type, expectation);
    // A network-level failure on this IP -> try the next; keep real answers.
    if (result.status === 'error' || result.status === 'timeout') {
      last = result;
      continue;
    }
    return result;
  }
  return (
    last ?? {
      status: 'error',
      nsIp: null,
      returnedValues: [],
      extraValues: [],
      error: 'noReachableIp',
    }
  );
}

/** Runs a full check for a single expectation across ALL authoritative NS. */
export async function checkHost(
  row: CheckRow,
  cache: DnsCache,
): Promise<HostResult> {
  const inputHostname = normalizeHostname(row.hostname);
  const registrableDomain = getRegistrableDomain(inputHostname);
  const expectation = parseExpectation(row.type, row.expectedValue);
  // Policy types (DMARC, MTA-STS, ...) are queried at a conventional sub-name.
  const queryName = resolveQueryName(row.type, inputHostname);

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

  const auth = await findAuthoritativeServers(queryName, cache);
  base.zone = auth.zone;
  base.authoritativeNameservers = auth.servers.map((s) => s.name);

  if (auth.servers.length === 0) {
    base.status = 'error';
    base.message = 'noAuthoritativeNameservers';
    return base;
  }

  // Query EVERY authoritative nameserver directly, in parallel, for freshness.
  base.nsAnswers = await Promise.all(
    auth.servers.map(async (server): Promise<NsAnswer> => {
      if (server.ips.length === 0) {
        return {
          nsName: server.name,
          nsIp: null,
          status: 'error',
          returnedValues: [],
          extraValues: [],
          error: 'nsIpResolutionFailed',
        };
      }
      const result = await checkAgainstNs(
        server.ips,
        queryName,
        row.type,
        expectation,
      );
      return {
        nsName: server.name,
        nsIp: result.nsIp,
        status: result.status,
        returnedValues: result.returnedValues,
        extraValues: result.extraValues,
        error: result.error,
      };
    }),
  );

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
