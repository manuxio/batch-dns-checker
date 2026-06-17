import { Resolver } from 'node:dns/promises';
import { config } from '../config';
import {
  buildZoneCandidates,
  getRegistrableDomain,
  normalizeHostname,
} from '../utils/domain';
import type { CheckRow, HostResult, NsAnswer, RecordType } from '../types';

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

/** Normalizes the user-provided expected value for a given record type. */
export function normalizeExpected(type: RecordType, rawValue: string): string {
  const value = rawValue.trim();
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
  expected: string,
): Promise<SingleNsResult> {
  const resolver = createPinnedResolver(ip);
  try {
    const returnedValues = await withRetry(() =>
      queryRecord(resolver, hostname, type),
    );
    const contains =
      returnedValues.includes(expected) ||
      mxMatchesWithoutPriority(expected, returnedValues);
    const extraValues = returnedValues.filter((v) => v !== expected);
    return {
      status: contains ? 'ok' : 'mismatch',
      returnedValues,
      extraValues: contains ? extraValues : [],
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
  const hostname = normalizeHostname(row.hostname);
  const registrableDomain = getRegistrableDomain(hostname);
  const expected = normalizeExpected(row.type, row.expectedValue);
  const defaultResolver = createDefaultResolver();

  const base: HostResult = {
    hostname,
    registrableDomain,
    type: row.type,
    expectedValue: row.expectedValue.trim(),
    zone: null,
    authoritativeNameservers: [],
    nsAnswers: [],
    status: 'error',
    warnings: [],
  };

  const { zone, nameservers } = await findAuthoritativeNameservers(
    hostname,
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
    const result = await checkAgainstNs(ips[0], hostname, row.type, expected);
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
