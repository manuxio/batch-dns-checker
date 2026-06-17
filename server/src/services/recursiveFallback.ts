import { Resolver } from 'node:dns/promises';
import { config } from '../config';
import { normalizeHostname } from '../utils/domain';

/**
 * Fallback resolution via the local/recursive resolver, used only when the
 * iterative-from-root path cannot reach the root servers (e.g. outbound :53 is
 * blocked and DNS is only allowed to a fixed forwarder).
 *
 * IMPORTANT: this path goes through a caching recursive resolver, so the answer
 * may be stale and cannot be verified per authoritative nameserver. It is a
 * degraded mode; results are flagged accordingly by the caller.
 */

function unquote(value: string): string {
  return value.trim().replace(/^"(.*)"$/s, '$1');
}

function createResolver(): Resolver {
  const resolver = new Resolver({
    timeout: config.dnsTimeoutMs,
    tries: config.dnsTries,
  });
  if (config.dnsFallbackServers.length > 0) {
    resolver.setServers(config.dnsFallbackServers);
  }
  return resolver;
}

/**
 * Resolves and normalizes the values of `wire` for `name` via the recursive
 * resolver. When `policyMarker` is set, only TXT records starting with that
 * marker are returned. Returns [] for NODATA/NXDOMAIN.
 */
export async function fetchViaLocalResolver(
  name: string,
  wire: string,
  policyMarker?: string,
): Promise<string[]> {
  const resolver = createResolver();
  try {
    if (policyMarker || wire === 'TXT') {
      const txts = (await resolver.resolveTxt(name)).map((chunks) =>
        unquote(chunks.join('')),
      );
      return policyMarker
        ? txts.filter((t) => t.trim().toLowerCase().startsWith(policyMarker))
        : txts;
    }
    switch (wire) {
      case 'A':
        return (await resolver.resolve4(name)).map((v) => v.toLowerCase());
      case 'AAAA':
        return (await resolver.resolve6(name)).map((v) => v.toLowerCase());
      case 'CNAME':
        return (await resolver.resolveCname(name)).map(normalizeHostname);
      case 'NS':
        return (await resolver.resolveNs(name)).map(normalizeHostname);
      case 'MX':
        return (await resolver.resolveMx(name)).map(
          (r) => `${r.priority} ${normalizeHostname(r.exchange)}`,
        );
      case 'SRV':
        return (await resolver.resolveSrv(name)).map(
          (r) => `${r.priority} ${r.weight} ${r.port} ${normalizeHostname(r.name)}`,
        );
      case 'CAA':
        return (await resolver.resolveCaa(name)).map((r) => {
          const flags = r.critical ?? 0;
          if (r.issue !== undefined) return `${flags} issue ${r.issue}`;
          if (r.issuewild !== undefined) return `${flags} issuewild ${r.issuewild}`;
          if (r.iodef !== undefined) return `${flags} iodef ${r.iodef}`;
          return `${flags} ${JSON.stringify(r)}`;
        });
      default:
        return [];
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? '';
    // No such record -> empty (a mismatch). Re-throw genuine failures.
    if (code === 'ENODATA' || code === 'ENOTFOUND' || code === 'NXDOMAIN') {
      return [];
    }
    throw err;
  }
}
