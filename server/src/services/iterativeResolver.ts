import net from 'node:net';
import { dnsQuery, type DnsRecord, type DnsResponse } from './dnsClient';
import { normalizeHostname } from '../utils/domain';
import { withRetry } from '../utils/retry';

/**
 * Iterative DNS resolver that always starts from the root servers, follows the
 * delegation chain (root -> TLD -> domain) and returns the domain's
 * authoritative nameservers. The authoritative servers come from the PARENT
 * delegation, so discovery does not depend on the zone publishing apex NS
 * records, and nothing is read through a caching recursive resolver.
 */

// IANA root server IPv4 addresses (root hints).
const ROOT_SERVERS = [
  '198.41.0.4', // a
  '199.9.14.201', // b
  '192.33.4.12', // c
  '199.7.91.13', // d
  '192.203.230.10', // e
  '192.5.5.241', // f
  '192.112.36.4', // g
  '198.97.190.53', // h
  '192.36.148.17', // i
  '192.58.128.30', // j
  '193.0.14.129', // k
  '199.7.83.42', // l
  '202.12.27.33', // m
];

export interface AuthServer {
  name: string;
  ips: string[];
}

export interface AuthLookup {
  zone: string | null;
  servers: AuthServer[];
}

/**
 * Per-batch cache of discovery results (NOT record values). Caching which
 * servers are authoritative is safe and fast; record values are always fetched
 * fresh from those servers.
 */
export interface ResolveCache {
  zoneServers: Map<string, AuthServer[]>; // zone -> delegated nameservers
  nsIps: Map<string, string[]>; // ns name -> IP addresses
  /** Set once root servers are found unreachable, to use the fallback path. */
  useFallback: boolean;
}

export function createResolveCache(): ResolveCache {
  return { zoneServers: new Map(), nsIps: new Map(), useFallback: false };
}

/** Thrown when no root server can be reached (e.g. outbound :53 is blocked). */
export class RootUnreachableError extends Error {
  constructor() {
    super('root servers unreachable');
    this.name = 'RootUnreachableError';
  }
}

/** Orders IPs with IPv4 first (IPv6 is often unreachable in containers). */
function ipv4First(ips: string[]): string[] {
  return [...ips].sort((a, b) => Number(net.isIPv6(a)) - Number(net.isIPv6(b)));
}

function isSubdomainOrEqual(name: string, zone: string): boolean {
  if (name === zone) return true;
  if (zone === '') return true; // root
  return name.endsWith(`.${zone}`);
}

/** Queries a set of servers in turn until one returns a usable response. */
async function queryAcross(
  servers: string[],
  name: string,
  type: string,
): Promise<DnsResponse | null> {
  for (const server of servers) {
    try {
      const response = await withRetry(() => dnsQuery(server, name, type), 2);
      if (response.rcode === 'NOERROR' || response.rcode === 'NXDOMAIN') {
        return response;
      }
      // SERVFAIL/REFUSED -> try the next server.
    } catch {
      // Network error/timeout -> try the next server.
    }
  }
  return null;
}

function collectGlue(records: DnsRecord[]): Map<string, string[]> {
  const glue = new Map<string, string[]>();
  for (const record of records) {
    if (record.type === 'A' || record.type === 'AAAA') {
      const name = normalizeHostname(record.name);
      const list = glue.get(name) ?? [];
      list.push(String(record.data));
      glue.set(name, list);
    }
  }
  return glue;
}

function nsRecordsFrom(response: DnsResponse): DnsRecord[] {
  return [...response.answers, ...response.authorities].filter(
    (r) => r.type === 'NS',
  );
}

/** Finds the longest cached ancestor zone to start the walk from (perf). */
function startingPoint(
  target: string,
  cache: ResolveCache,
): { servers: string[]; zone: string } {
  const labels = target.split('.');
  for (let i = 0; i < labels.length; i += 1) {
    const candidate = labels.slice(i).join('.');
    const cached = cache.zoneServers.get(candidate);
    if (cached) {
      const ips = cached.flatMap((s) => s.ips);
      if (ips.length > 0) return { servers: ips, zone: candidate };
    }
  }
  return { servers: ROOT_SERVERS, zone: '' };
}

/**
 * Finds the authoritative nameservers for a name by walking from the root.
 * Returns the deepest delegation that covers the name.
 */
export async function findAuthoritativeServers(
  name: string,
  cache: ResolveCache,
  depth = 0,
): Promise<AuthLookup> {
  const target = normalizeHostname(name);

  const exact = cache.zoneServers.get(target);
  if (exact) return { zone: target, servers: exact };

  if (depth > 8) return { zone: null, servers: [] };

  const start = startingPoint(target, cache);
  let servers = start.servers;
  let currentZone = start.zone;
  let lastDelegation: AuthLookup = { zone: null, servers: [] };
  const seen = new Set<string>();

  for (let step = 0; step < 32; step += 1) {
    const response = await queryAcross(servers, target, 'NS');
    if (!response) {
      // Could not reach any root server on the very first hop: outbound DNS to
      // arbitrary servers is likely blocked. Signal the caller to fall back.
      if (step === 0 && start.zone === '') throw new RootUnreachableError();
      break;
    }

    const nsRecords = nsRecordsFrom(response);
    if (nsRecords.length === 0) {
      // No deeper delegation: the servers we just queried are authoritative.
      break;
    }

    const zone = normalizeHostname(nsRecords[0].name);
    if (!isSubdomainOrEqual(target, zone) || zone === currentZone || seen.has(zone)) {
      break;
    }
    seen.add(zone);

    const glue = collectGlue(response.additionals);
    const nsNames = Array.from(
      new Set(nsRecords.map((r) => normalizeHostname(String(r.data)))),
    );
    const delegation: AuthServer[] = nsNames.map((nsName) => ({
      name: nsName,
      ips: ipv4First(glue.get(nsName) ?? []),
    }));

    await ensureServerIps(delegation, cache, depth);
    lastDelegation = { zone, servers: delegation };
    cache.zoneServers.set(zone, delegation);
    currentZone = zone;

    if (zone === target) return lastDelegation;

    const ips = delegation.flatMap((s) => s.ips);
    if (ips.length === 0) break;
    servers = ips;
  }

  return lastDelegation;
}

/** Ensures each delegation nameserver has at least one IP (glue or resolved). */
async function ensureServerIps(
  servers: AuthServer[],
  cache: ResolveCache,
  depth: number,
): Promise<void> {
  await Promise.all(
    servers.map(async (server) => {
      if (server.ips.length > 0) {
        server.ips = ipv4First(server.ips);
        cache.nsIps.set(server.name, server.ips);
        return;
      }
      server.ips = await resolveAddress(server.name, cache, depth + 1);
    }),
  );
}

/** Iteratively resolves a hostname's IPv4 (and IPv6) addresses. */
export async function resolveAddress(
  name: string,
  cache: ResolveCache,
  depth = 0,
): Promise<string[]> {
  const host = normalizeHostname(name);
  const cached = cache.nsIps.get(host);
  if (cached) return cached;
  if (depth > 8) return [];

  const auth = await findAuthoritativeServers(host, cache, depth);
  const serverIps = auth.servers.flatMap((s) => s.ips);
  const ips: string[] = [];
  if (serverIps.length > 0) {
    for (const type of ['A', 'AAAA']) {
      const response = await queryAcross(serverIps, host, type);
      if (response) {
        ips.push(
          ...response.answers
            .filter((r) => r.type === type)
            .map((r) => String(r.data)),
        );
      }
    }
  }
  const ordered = ipv4First(ips);
  cache.nsIps.set(host, ordered);
  return ordered;
}

export { ROOT_SERVERS };
