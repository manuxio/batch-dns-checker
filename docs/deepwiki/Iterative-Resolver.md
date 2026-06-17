# Iterative Resolver
Relevant source files
- [server/src/services/dnsClient.ts](https://github.com/manuxio/batch-dns-checker/blob/ba4e9a28/server/src/services/dnsClient.ts)
- [server/src/services/iterativeResolver.ts](https://github.com/manuxio/batch-dns-checker/blob/ba4e9a28/server/src/services/iterativeResolver.ts)
- [server/src/utils/domain.ts](https://github.com/manuxio/batch-dns-checker/blob/ba4e9a28/server/src/utils/domain.ts)
- [server/src/utils/retry.ts](https://github.com/manuxio/batch-dns-checker/blob/ba4e9a28/server/src/utils/retry.ts)

The Iterative Resolver is a specialized DNS engine designed to bypass caching recursive resolvers. It performs a "walk" from the IANA root servers down to the authoritative nameservers for a specific domain. This ensures that the compliance checker always evaluates records directly from the source of truth, satisfying the requirement for authoritative-only verification.

## Core Logic and Delegation Walking

The resolver implements iterative resolution by sending queries with the Recursion Desired flag set to zero (`RD=0`) [server/src/services/dnsClient.ts43](https://github.com/manuxio/batch-dns-checker/blob/ba4e9a28/server/src/services/dnsClient.ts#L43-L43) This forces the queried server to return a referral (delegation) rather than performing the lookup on behalf of the client.

### Delegation Chain Flow

The resolution process follows the standard DNS hierarchy:

1. **Root Hints**: The process begins with a hardcoded list of IANA root server IPv4 addresses [server/src/services/iterativeResolver.ts15-29](https://github.com/manuxio/batch-dns-checker/blob/ba4e9a28/server/src/services/iterativeResolver.ts#L15-L29)
2. **TLD Referral**: Querying a root server for a domain (e.g., `example.com`) returns the nameservers for the Top-Level Domain (e.g., `.com`).
3. **Authoritative Referral**: Querying the TLD servers returns the nameservers delegated by the parent for the specific domain.
4. **Terminal Point**: The walk stops when a server returns an answer with records or a `NXDOMAIN` status, or when the `depth` limit (8) or `step` limit (32) is reached [server/src/services/iterativeResolver.ts146](https://github.com/manuxio/batch-dns-checker/blob/ba4e9a28/server/src/services/iterativeResolver.ts#L146-L146)[server/src/services/iterativeResolver.ts154](https://github.com/manuxio/batch-dns-checker/blob/ba4e9a28/server/src/services/iterativeResolver.ts#L154-L154)

### Data Flow: Root to Authoritative

The following diagram illustrates how `findAuthoritativeServers` traverses the hierarchy.

**Iterative Walk Sequence**

Sources: [server/src/services/iterativeResolver.ts136-197](https://github.com/manuxio/batch-dns-checker/blob/ba4e9a28/server/src/services/iterativeResolver.ts#L136-L197)[server/src/services/iterativeResolver.ts77-94](https://github.com/manuxio/batch-dns-checker/blob/ba4e9a28/server/src/services/iterativeResolver.ts#L77-L94)[server/src/services/iterativeResolver.ts96-107](https://github.com/manuxio/batch-dns-checker/blob/ba4e9a28/server/src/services/iterativeResolver.ts#L96-L107)

## Glue Record Handling and IP Resolution

A critical aspect of iterative resolution is handling **Glue Records**. These are A/AAAA records provided in the `ADDITIONAL` section of a DNS response to prevent circular dependencies (e.g., when `ns1.example.com` is the nameserver for `example.com`).

- **`collectGlue`**: This function iterates through the `additionals` section of a `DnsResponse` to map nameserver hostnames to their IP addresses [server/src/services/iterativeResolver.ts96-107](https://github.com/manuxio/batch-dns-checker/blob/ba4e9a28/server/src/services/iterativeResolver.ts#L96-L107)
- **`ensureServerIps`**: If a delegation provides nameservers but no glue records, this function triggers a sub-resolution using `resolveAddress` to find the IPs of those nameservers [server/src/services/iterativeResolver.ts199-215](https://github.com/manuxio/batch-dns-checker/blob/ba4e9a28/server/src/services/iterativeResolver.ts#L199-L215)
- **`ipv4First`**: To ensure stability in containerized environments where IPv6 might be misconfigured, the resolver sorts available IPs to prefer IPv4 [server/src/services/iterativeResolver.ts66-68](https://github.com/manuxio/batch-dns-checker/blob/ba4e9a28/server/src/services/iterativeResolver.ts#L66-L68)

## ResolveCache Design

To optimize performance during batch processing, the resolver uses a `ResolveCache`. This cache is per-batch and stores infrastructure metadata rather than record values.

| Property | Type | Description |
| --- | --- | --- |
| `zoneServers` | `Map<string, AuthServer[]>` | Maps a zone (e.g., "com") to its delegated nameservers [server/src/services/iterativeResolver.ts47](https://github.com/manuxio/batch-dns-checker/blob/ba4e9a28/server/src/services/iterativeResolver.ts#L47-L47) |
| `nsIps` | `Map<string, string[]>` | Maps a nameserver hostname to its resolved IP addresses [server/src/services/iterativeResolver.ts48](https://github.com/manuxio/batch-dns-checker/blob/ba4e9a28/server/src/services/iterativeResolver.ts#L48-L48) |
| `useFallback` | `boolean` | Flag set to `true` if root servers are unreachable, triggering the recursive fallback [server/src/services/iterativeResolver.ts50](https://github.com/manuxio/batch-dns-checker/blob/ba4e9a28/server/src/services/iterativeResolver.ts#L50-L50) |

The `startingPoint` function uses this cache to find the longest cached ancestor for a target domain, allowing the resolver to skip the root/TLD steps for subsequent domains in the same TLD [server/src/services/iterativeResolver.ts116-130](https://github.com/manuxio/batch-dns-checker/blob/ba4e9a28/server/src/services/iterativeResolver.ts#L116-L130)

Sources: [server/src/services/iterativeResolver.ts41-55](https://github.com/manuxio/batch-dns-checker/blob/ba4e9a28/server/src/services/iterativeResolver.ts#L41-L55)[server/src/services/iterativeResolver.ts116-130](https://github.com/manuxio/batch-dns-checker/blob/ba4e9a28/server/src/services/iterativeResolver.ts#L116-L130)

## Error Handling and Fallback

The resolver is designed to fail gracefully when network environments restrict direct outbound DNS traffic.

### RootUnreachableError

If the very first hop to the IANA root servers fails (usually due to a firewall blocking port 53), the system throws a `RootUnreachableError`[server/src/services/iterativeResolver.ts58-63](https://github.com/manuxio/batch-dns-checker/blob/ba4e9a28/server/src/services/iterativeResolver.ts#L58-L63) This occurs specifically when `step === 0` and the `start.zone` is the root [server/src/services/iterativeResolver.ts159](https://github.com/manuxio/batch-dns-checker/blob/ba4e9a28/server/src/services/iterativeResolver.ts#L159-L159)

### Resilience Mechanisms

- **`queryAcross`**: Iterates through all available IPs for a delegation until one responds with a valid `NOERROR` or `NXDOMAIN`[server/src/services/iterativeResolver.ts77-94](https://github.com/manuxio/batch-dns-checker/blob/ba4e9a28/server/src/services/iterativeResolver.ts#L77-L94)
- **`withRetry`**: Wraps the `dnsQuery` call with an exponential backoff strategy for transient errors like `ETIMEOUT` or `ECONNRESET`[server/src/utils/retry.ts32-48](https://github.com/manuxio/batch-dns-checker/blob/ba4e9a28/server/src/utils/retry.ts#L32-L48)[server/src/utils/retry.ts8-13](https://github.com/manuxio/batch-dns-checker/blob/ba4e9a28/server/src/utils/retry.ts#L8-L13)

## Code Entity Map

The following diagram maps the logical DNS concepts to the specific TypeScript entities in the codebase.

**Logic to Code Entity Mapping**

Sources: [server/src/services/iterativeResolver.ts136](https://github.com/manuxio/batch-dns-checker/blob/ba4e9a28/server/src/services/iterativeResolver.ts#L136-L136)[server/src/services/iterativeResolver.ts116](https://github.com/manuxio/batch-dns-checker/blob/ba4e9a28/server/src/services/iterativeResolver.ts#L116-L116)[server/src/services/iterativeResolver.ts77](https://github.com/manuxio/batch-dns-checker/blob/ba4e9a28/server/src/services/iterativeResolver.ts#L77-L77)[server/src/services/dnsClient.ts170](https://github.com/manuxio/batch-dns-checker/blob/ba4e9a28/server/src/services/dnsClient.ts#L170-L170)[server/src/services/dnsClient.ts43](https://github.com/manuxio/batch-dns-checker/blob/ba4e9a28/server/src/services/dnsClient.ts#L43-L43)