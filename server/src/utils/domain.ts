import { getDomain, parse } from 'tldts';

/**
 * Returns the registrable ("secondary-level") domain for a hostname using the
 * Public Suffix List. Examples:
 *   host.example.it        -> example.it
 *   a.b.example.co.uk      -> example.co.uk
 * Falls back to the input (lower-cased, trailing dot stripped) when the PSL
 * cannot determine a registrable domain.
 */
export function getRegistrableDomain(hostname: string): string {
  const normalized = normalizeHostname(hostname);
  const domain = getDomain(normalized);
  return domain ?? normalized;
}

/** Lower-cases a hostname and removes a single trailing dot. */
export function normalizeHostname(hostname: string): string {
  return hostname.trim().toLowerCase().replace(/\.$/, '');
}

/**
 * Builds the list of candidate zone names for a hostname, ordered from the most
 * specific (the hostname itself) down to the registrable domain. Used to locate
 * the closest delegation point (zone cut) that owns NS records.
 */
export function buildZoneCandidates(hostname: string): string[] {
  const normalized = normalizeHostname(hostname);
  const registrable = getRegistrableDomain(normalized);
  const candidates: string[] = [];

  const labels = normalized.split('.');
  const registrableLabelCount = registrable.split('.').length;

  // Add increasingly less specific names until we reach the registrable domain.
  for (let i = 0; i <= labels.length - registrableLabelCount; i += 1) {
    candidates.push(labels.slice(i).join('.'));
  }

  if (!candidates.includes(registrable)) {
    candidates.push(registrable);
  }
  return candidates;
}

/** True when the hostname looks like a syntactically valid FQDN. */
export function isValidHostname(hostname: string): boolean {
  const normalized = normalizeHostname(hostname);
  if (normalized.length === 0 || normalized.length > 253) return false;
  const parsed = parse(normalized);
  if (!parsed.domain && !parsed.hostname) return false;
  // Each label: 1-63 chars, alphanumerics, hyphen/underscore (underscore for
  // service records like _sip._tcp), not starting/ending with hyphen.
  return normalized
    .split('.')
    .every((label) => /^(?!-)[a-z0-9_-]{1,63}(?<!-)$/.test(label));
}
