# DNS Compliance Checker
Relevant source files
- [server/src/services/dnsChecker.ts](https://github.com/manuxio/batch-dns-checker/blob/ba4e9a28/server/src/services/dnsChecker.ts)
- [server/src/services/dnsClient.ts](https://github.com/manuxio/batch-dns-checker/blob/ba4e9a28/server/src/services/dnsClient.ts)
- [server/src/types.ts](https://github.com/manuxio/batch-dns-checker/blob/ba4e9a28/server/src/types.ts)
- [server/src/utils/retry.ts](https://github.com/manuxio/batch-dns-checker/blob/ba4e9a28/server/src/utils/retry.ts)

The DNS Compliance Checker is the core engine of the application, responsible for verifying that specific DNS records across various authoritative nameservers match user-defined expectations. Unlike standard recursive resolvers that may serve cached data, this engine performs iterative resolution to query the source of truth directly.

## Lifecycle of checkHost

The `checkHost` function [server/src/services/dnsChecker.ts251-344](https://github.com/manuxio/batch-dns-checker/blob/ba4e9a28/server/src/services/dnsChecker.ts#L251-L344) orchestrates the entire verification process for a single input row. It transitions through several stages: from resolving the correct FQDN for policy types to identifying authoritative nameservers and aggregating multi-server results.

### Data Flow and Lifecycle

1. **Normalization**: The hostname is normalized, and the registrable domain is extracted [server/src/services/dnsChecker.ts256-258](https://github.com/manuxio/batch-dns-checker/blob/ba4e9a28/server/src/services/dnsChecker.ts#L256-L258)
2. **Policy Resolution**: If the record type is a policy type (e.g., DMARC), the `queryName` is adjusted to include the required prefix (e.g., `_dmarc.`) [server/src/services/dnsChecker.ts260](https://github.com/manuxio/batch-dns-checker/blob/ba4e9a28/server/src/services/dnsChecker.ts#L260-L260)
3. **Expectation Parsing**: The `expectedValue` string is parsed into an `Expectation` object, determining the `MatchMode` (single, all, or any) [server/src/services/dnsChecker.ts262](https://github.com/manuxio/batch-dns-checker/blob/ba4e9a28/server/src/services/dnsChecker.ts#L262-L262)
4. **Authoritative Discovery**: The system uses `findAuthoritativeServers`[server/src/services/iterativeResolver.ts133](https://github.com/manuxio/batch-dns-checker/blob/ba4e9a28/server/src/services/iterativeResolver.ts#L133-L133) to walk the delegation chain from the root servers down to the target zone [server/src/services/dnsChecker.ts267](https://github.com/manuxio/batch-dns-checker/blob/ba4e9a28/server/src/services/dnsChecker.ts#L267-L267)
5. **Direct Querying**: For every identified nameserver, the engine performs a direct DNS query with Recursion Desired (`RD=0`) [server/src/services/dnsClient.ts43](https://github.com/manuxio/batch-dns-checker/blob/ba4e9a28/server/src/services/dnsClient.ts#L43-L43)
6. **Aggregation**: The `aggregateResults` function [server/src/services/dnsChecker.ts346](https://github.com/manuxio/batch-dns-checker/blob/ba4e9a28/server/src/services/dnsChecker.ts#L346-L346) evaluates the individual `NsAnswer` objects to produce a final `HostResultStatus`.

**DNS Check Lifecycle**

Sources: [server/src/services/dnsChecker.ts251-344](https://github.com/manuxio/batch-dns-checker/blob/ba4e9a28/server/src/services/dnsChecker.ts#L251-L344)[server/src/services/dnsClient.ts43](https://github.com/manuxio/batch-dns-checker/blob/ba4e9a28/server/src/services/dnsClient.ts#L43-L43)[server/src/services/iterativeResolver.ts133-176](https://github.com/manuxio/batch-dns-checker/blob/ba4e9a28/server/src/services/iterativeResolver.ts#L133-L176)

---

## Policy-Type Resolution

The checker supports "Policy Types"—pseudo-record types that represent security policies usually stored in `TXT` records. These are defined in the `POLICY_TYPES` map [server/src/services/dnsChecker.ts56-63](https://github.com/manuxio/batch-dns-checker/blob/ba4e9a28/server/src/services/dnsChecker.ts#L56-L63)

| Type | Prefix | Marker | Purpose |
| --- | --- | --- | --- |
| **SPF** | (empty) | `v=spf1` | Sender Policy Framework |
| **DKIM** | (empty) | `v=dkim1` | DomainKeys Identified Mail (Selector in hostname) |
| **DMARC** | `_dmarc` | `v=dmarc1` | Domain-based Message Authentication |
| **MTASTS** | `_mta-sts` | `v=stsv1` | MTA Strict Transport Security |
| **TLSRPT** | `_smtp._tls` | `v=tlsrptv1` | SMTP TLS Reporting |
| **BIMI** | `default._bimi` | `v=bimi1` | Brand Indicators for Message Identification |

When a policy type is detected via `isPolicyType`[server/src/services/dnsChecker.ts65-67](https://github.com/manuxio/batch-dns-checker/blob/ba4e9a28/server/src/services/dnsChecker.ts#L65-L67) the `resolveQueryName` function [server/src/services/dnsChecker.ts75-85](https://github.com/manuxio/batch-dns-checker/blob/ba4e9a28/server/src/services/dnsChecker.ts#L75-L85) ensures the hostname is correctly prefixed. For example, a check for `DMARC` on `example.com` results in a query for `_dmarc.example.com`.

Sources: [server/src/services/dnsChecker.ts49-85](https://github.com/manuxio/batch-dns-checker/blob/ba4e9a28/server/src/services/dnsChecker.ts#L49-L85)

---

## Expectation Parsing and Match Modes

The `parseExpectation` function [server/src/services/dnsChecker.ts198-232](https://github.com/manuxio/batch-dns-checker/blob/ba4e9a28/server/src/services/dnsChecker.ts#L198-L232) transforms a raw string into a structured `Expectation` object. It supports logical operators to validate multiple values within a single record or across multiple records.

- **AND Mode (`&`)**: All specified values must be present in the DNS response.
- **OR Mode (`|`)**: At least one of the specified values must be present.
- **Single Mode**: Used when no operators are present; the DNS response must contain exactly the expected value.

**Normalization Logic**:
Before comparison, both the expected values and the returned DNS data are passed through `normalizeExpected`[server/src/services/dnsChecker.ts88-131](https://github.com/manuxio/batch-dns-checker/blob/ba4e9a28/server/src/services/dnsChecker.ts#L88-L131) and `normalizeAnswer`[server/src/services/dnsChecker.ts145-175](https://github.com/manuxio/batch-dns-checker/blob/ba4e9a28/server/src/services/dnsChecker.ts#L145-L175) This handles:

- Case-insensitivity for hostnames (CNAME, NS, MX).
- Unquoting `TXT` and `CAA` records [server/src/services/dnsChecker.ts39-41](https://github.com/manuxio/batch-dns-checker/blob/ba4e9a28/server/src/services/dnsChecker.ts#L39-L41)
- Formatting `MX` (priority + host) and `SRV` records for consistent string comparison.

Sources: [server/src/services/dnsChecker.ts198-249](https://github.com/manuxio/batch-dns-checker/blob/ba4e9a28/server/src/services/dnsChecker.ts#L198-L249)[server/src/services/dnsChecker.ts88-175](https://github.com/manuxio/batch-dns-checker/blob/ba4e9a28/server/src/services/dnsChecker.ts#L88-L175)

---

## Per-NS Querying with RD=0

To ensure data integrity, the system queries each authoritative nameserver directly.

1. **IP Resolution**: For each nameserver name returned by the iterative resolver, the system resolves its A/AAAA records using `resolveAddress`[server/src/services/iterativeResolver.ts111](https://github.com/manuxio/batch-dns-checker/blob/ba4e9a28/server/src/services/iterativeResolver.ts#L111-L111)
2. **Direct Query**: The `dnsQuery` function [server/src/services/dnsClient.ts170-181](https://github.com/manuxio/batch-dns-checker/blob/ba4e9a28/server/src/services/dnsClient.ts#L170-L181) sends a raw UDP packet (with TCP fallback) where the `Recursion Desired` (RD) flag is set to `0`[server/src/services/dnsClient.ts43](https://github.com/manuxio/batch-dns-checker/blob/ba4e9a28/server/src/services/dnsClient.ts#L43-L43)
3. **EDNS0**: Queries include an `OPT` record with a `udpPayloadSize` of 4096 to minimize truncation [server/src/services/dnsClient.ts46-48](https://github.com/manuxio/batch-dns-checker/blob/ba4e9a28/server/src/services/dnsClient.ts#L46-L48)
4. **Retries**: Transient network errors (e.g., `ETIMEOUT`, `ECONNRESET`) are handled by `withRetry`[server/src/utils/retry.ts32-48](https://github.com/manuxio/batch-dns-checker/blob/ba4e9a28/server/src/utils/retry.ts#L32-L48) which uses a backoff table configured in the system [server/src/utils/retry.ts23-26](https://github.com/manuxio/batch-dns-checker/blob/ba4e9a28/server/src/utils/retry.ts#L23-L26)

**Direct Query Implementation**

Sources: [server/src/services/dnsClient.ts1-181](https://github.com/manuxio/batch-dns-checker/blob/ba4e9a28/server/src/services/dnsClient.ts#L1-L181)[server/src/services/dnsChecker.ts390-438](https://github.com/manuxio/batch-dns-checker/blob/ba4e9a28/server/src/services/dnsChecker.ts#L390-L438)[server/src/utils/retry.ts1-48](https://github.com/manuxio/batch-dns-checker/blob/ba4e9a28/server/src/utils/retry.ts#L1-L48)

---

## Result Aggregation and Status

The final status of a host is determined by `aggregateResults`[server/src/services/dnsChecker.ts346-388](https://github.com/manuxio/batch-dns-checker/blob/ba4e9a28/server/src/services/dnsChecker.ts#L346-L388) which evaluates the collection of `NsAnswer` objects.

| Status | Condition |
| --- | --- |
| **ok** | All nameservers returned the expected values and no inconsistencies were found. |
| **warning** | The expectation was met, but issues exist (e.g., extra records found in a "contains" match, or inconsistent results between different nameservers). |
| **error** | At least one nameserver returned a mismatch, or all nameservers failed/timed out. |

**Inconsistency Detection**:
The engine compares the `returnedValues` across all nameservers. If different nameservers provide different sets of records for the same query, a warning is added to the `warnings` array [server/src/services/dnsChecker.ts373-377](https://github.com/manuxio/batch-dns-checker/blob/ba4e9a28/server/src/services/dnsChecker.ts#L373-L377)

**Aggregate Status Logic**

Sources: [server/src/services/dnsChecker.ts346-388](https://github.com/manuxio/batch-dns-checker/blob/ba4e9a28/server/src/services/dnsChecker.ts#L346-L388)[server/src/types.ts53-88](https://github.com/manuxio/batch-dns-checker/blob/ba4e9a28/server/src/types.ts#L53-L88)