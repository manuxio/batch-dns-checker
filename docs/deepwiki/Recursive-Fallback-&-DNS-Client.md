# Recursive Fallback & DNS Client
Relevant source files
- [server/src/config.ts](https://github.com/manuxio/batch-dns-checker/blob/ba4e9a28/server/src/config.ts)
- [server/src/services/dnsClient.ts](https://github.com/manuxio/batch-dns-checker/blob/ba4e9a28/server/src/services/dnsClient.ts)
- [server/src/services/recursiveFallback.ts](https://github.com/manuxio/batch-dns-checker/blob/ba4e9a28/server/src/services/recursiveFallback.ts)
- [server/src/utils/retry.ts](https://github.com/manuxio/batch-dns-checker/blob/ba4e9a28/server/src/utils/retry.ts)

This page documents the lower-level DNS infrastructure of the application. It covers `dnsClient.ts`, which provides raw packet construction for iterative resolution, and `recursiveFallback.ts`, which ensures the system remains functional when direct outbound access to root servers is restricted.

## Low-Level DNS Client (`dnsClient.ts`)

The `dnsClient.ts` module implements a minimal DNS client using the `dns-packet` library. Unlike the standard Node.js `dns` module, this client is designed for **Iterative Resolution**.

### Key Features

- **RD=0 (Recursion Desired: False)**: Queries are sent with the `RD` flag set to `0`[server/src/services/dnsClient.ts43](https://github.com/manuxio/batch-dns-checker/blob/ba4e9a28/server/src/services/dnsClient.ts#L43-L43) This forces authoritative nameservers to return referrals (AUTHORITY and ADDITIONAL sections) rather than performing the lookup themselves.
- **EDNS0 Support**: Includes an `OPT` record in the `additionals` section with a `udpPayloadSize` of 4096 bytes to minimize truncation [server/src/services/dnsClient.ts46-48](https://github.com/manuxio/batch-dns-checker/blob/ba4e9a28/server/src/services/dnsClient.ts#L46-L48)
- **Automatic TCP Fallback**: If a UDP response has the truncation flag (`TC`) set, the client automatically re-attempts the query over TCP [server/src/services/dnsClient.ts176-180](https://github.com/manuxio/batch-dns-checker/blob/ba4e9a28/server/src/services/dnsClient.ts#L176-L180)
- **Raw Section Access**: Provides access to `answers`, `authorities`, and `additionals` sections, which is required for walking the delegation chain and handling glue records [server/src/services/dnsClient.ts26-33](https://github.com/manuxio/batch-dns-checker/blob/ba4e9a28/server/src/services/dnsClient.ts#L26-L33)

### Data Flow: DNS Query Lifecycle

The following diagram illustrates how a query is processed by the `dnsClient`.

**Title: DNS Client Query Logic**

Sources: [server/src/services/dnsClient.ts39-181](https://github.com/manuxio/batch-dns-checker/blob/ba4e9a28/server/src/services/dnsClient.ts#L39-L181)

## Recursive Fallback (`recursiveFallback.ts`)

The `recursiveFallback.ts` module provides a secondary resolution path using the Node.js `dns/promises``Resolver` class [server/src/services/recursiveFallback.ts1](https://github.com/manuxio/batch-dns-checker/blob/ba4e9a28/server/src/services/recursiveFallback.ts#L1-L1)

### Usage Scenarios

This path is utilized in two specific conditions:

1. **Network Restrictions**: When the iterative resolver cannot reach root servers (e.g., outbound port 53 is blocked, common in restricted corporate environments) [server/src/services/recursiveFallback.ts5-8](https://github.com/manuxio/batch-dns-checker/blob/ba4e9a28/server/src/services/recursiveFallback.ts#L5-L8)
2. **Forced Configuration**: When `DNS_FORCE_LOCAL_RESOLVER` is set to `true` in the environment [server/src/config.ts24](https://github.com/manuxio/batch-dns-checker/blob/ba4e9a28/server/src/config.ts#L24-L24)

### Implementation Details

The core function `fetchViaLocalResolver` wraps standard Node.js resolution methods and normalizes the output to match the application's internal expectations.

| Record Type | Node.js Method Used | Normalization |
| --- | --- | --- |
| **TXT** | `resolveTxt` | Unquotes and joins chunks; filters by `policyMarker`[server/src/services/recursiveFallback.ts42-49](https://github.com/manuxio/batch-dns-checker/blob/ba4e9a28/server/src/services/recursiveFallback.ts#L42-L49) |
| **A / AAAA** | `resolve4` / `resolve6` | Lowercases IP strings [server/src/services/recursiveFallback.ts51-54](https://github.com/manuxio/batch-dns-checker/blob/ba4e9a28/server/src/services/recursiveFallback.ts#L51-L54) |
| **MX** | `resolveMx` | Formats as `${priority} ${exchange}`[server/src/services/recursiveFallback.ts59-62](https://github.com/manuxio/batch-dns-checker/blob/ba4e9a28/server/src/services/recursiveFallback.ts#L59-L62) |
| **CAA** | `resolveCaa` | Formats flags and properties (issue, issuewild, iodef) [server/src/services/recursiveFallback.ts67-74](https://github.com/manuxio/batch-dns-checker/blob/ba4e9a28/server/src/services/recursiveFallback.ts#L67-L74) |

**Warning**: Because this path uses a caching recursive resolver, results may be stale and cannot be verified against specific authoritative nameservers [server/src/services/recursiveFallback.ts10-12](https://github.com/manuxio/batch-dns-checker/blob/ba4e9a28/server/src/services/recursiveFallback.ts#L10-L12)

Sources: [server/src/services/recursiveFallback.ts35-86](https://github.com/manuxio/batch-dns-checker/blob/ba4e9a28/server/src/services/recursiveFallback.ts#L35-L86)[server/src/config.ts24-29](https://github.com/manuxio/batch-dns-checker/blob/ba4e9a28/server/src/config.ts#L24-L29)

## Retry and Error Handling

Both modules rely on `withRetry` from `retry.ts` to handle transient network issues.

### Retryable Codes

The system only retries on specific errors defined in `RETRYABLE_CODES`:

- `ETIMEOUT` / `ETIMEDOUT`
- `ECONNRESET`
- `EAI_AGAIN` (DNS lookup timed out)

Errors like `ECONNREFUSED` or `EHOSTUNREACH` fail immediately to allow the system to try the next available IP address in a nameserver set [server/src/utils/retry.ts3-13](https://github.com/manuxio/batch-dns-checker/blob/ba4e9a28/server/src/utils/retry.ts#L3-L13)

### Backoff Strategy

The retry mechanism uses a configurable backoff table from `config.dnsBackoffMs`[server/src/utils/retry.ts23-26](https://github.com/manuxio/batch-dns-checker/blob/ba4e9a28/server/src/utils/retry.ts#L23-L26) By default, it follows an increasing delay: 100ms, 500ms, 1s, 2s, and 2s for subsequent attempts [server/src/config.ts19](https://github.com/manuxio/batch-dns-checker/blob/ba4e9a28/server/src/config.ts#L19-L19)

**Title: Retry Mechanism Integration**

Sources: [server/src/utils/retry.ts15-48](https://github.com/manuxio/batch-dns-checker/blob/ba4e9a28/server/src/utils/retry.ts#L15-L48)[server/src/config.ts16-19](https://github.com/manuxio/batch-dns-checker/blob/ba4e9a28/server/src/config.ts#L16-L19)