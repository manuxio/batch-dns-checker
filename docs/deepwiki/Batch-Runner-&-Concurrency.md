# Batch Runner & Concurrency
Relevant source files
- [server/src/config.ts](https://github.com/manuxio/batch-dns-checker/blob/ba4e9a28/server/src/config.ts)
- [server/src/services/batchRunner.ts](https://github.com/manuxio/batch-dns-checker/blob/ba4e9a28/server/src/services/batchRunner.ts)
- [server/src/services/dnsChecker.ts](https://github.com/manuxio/batch-dns-checker/blob/ba4e9a28/server/src/services/dnsChecker.ts)

The `batchRunner.ts` module is the orchestration engine of the system. It manages the asynchronous execution of DNS checks for large datasets, providing bounded concurrency, live progress tracking, and cooperative cancellation.

## Architecture Overview

Batch processing follows a "fire-and-forget" pattern where a batch is initialized in memory, persisted to the database, and then processed by a pool of workers.

### The ActiveBatch Map

While a batch is running, its state is maintained in an in-memory `Map` called `activeBatches`[server/src/services/batchRunner.ts44](https://github.com/manuxio/batch-dns-checker/blob/ba4e9a28/server/src/services/batchRunner.ts#L44-L44) This allows for high-frequency updates and immediate access to progress data without constant database lookups. Once a batch completes or is stopped, it is removed from this map [server/src/services/batchRunner.ts201](https://github.com/manuxio/batch-dns-checker/blob/ba4e9a28/server/src/services/batchRunner.ts#L201-L201)

### Data Flow: Start to Finish

The following diagram illustrates the lifecycle of a batch from the initial `startBatch` call to its final persistence.

**Batch Lifecycle and Entity Interaction**

**Sources:**[server/src/services/batchRunner.ts74-126](https://github.com/manuxio/batch-dns-checker/blob/ba4e9a28/server/src/services/batchRunner.ts#L74-L126)[server/src/services/batchRunner.ts140-202](https://github.com/manuxio/batch-dns-checker/blob/ba4e9a28/server/src/services/batchRunner.ts#L140-L202)

---

## Concurrency & Worker Pool

The system implements a worker-pool pattern to manage DNS query volume.

- **Concurrency Limit**: The number of simultaneous host checks is governed by `config.hostConcurrency`[server/src/services/batchRunner.ts182](https://github.com/manuxio/batch-dns-checker/blob/ba4e9a28/server/src/services/batchRunner.ts#L182-L182) which defaults to the `DNS_HOST_CONCURRENCY` environment variable [server/src/config.ts15](https://github.com/manuxio/batch-dns-checker/blob/ba4e9a28/server/src/config.ts#L15-L15)
- **Shared Cache**: All workers within a single batch share a `DnsCache` (ResolveCache) [server/src/services/batchRunner.ts148](https://github.com/manuxio/batch-dns-checker/blob/ba4e9a28/server/src/services/batchRunner.ts#L148-L148) This ensures that if multiple rows belong to the same domain, the authoritative nameserver lookup (root-to-TLD-to-domain) is performed only once [server/src/services/dnsChecker.ts20-30](https://github.com/manuxio/batch-dns-checker/blob/ba4e9a28/server/src/services/dnsChecker.ts#L20-L30)
- **Worker Logic**: Workers pull indices from a shared `nextIndex` counter [server/src/services/batchRunner.ts155-156](https://github.com/manuxio/batch-dns-checker/blob/ba4e9a28/server/src/services/batchRunner.ts#L155-L156) Each worker executes a `while` loop until all rows are processed or a cancellation is requested [server/src/services/batchRunner.ts153-180](https://github.com/manuxio/batch-dns-checker/blob/ba4e9a28/server/src/services/batchRunner.ts#L153-L180)

**Sources:**[server/src/services/batchRunner.ts140-183](https://github.com/manuxio/batch-dns-checker/blob/ba4e9a28/server/src/services/batchRunner.ts#L140-L183)[server/src/config.ts15](https://github.com/manuxio/batch-dns-checker/blob/ba4e9a28/server/src/config.ts#L15-L15)

---

## Cooperative Cancellation

Cancellation is "cooperative," meaning workers check a flag rather than being forcibly terminated.

1. **Request**: When `stopBatch(id)` is called, the `cancelRequested` flag for that specific `ActiveBatch` is set to `true`[server/src/services/batchRunner.ts228-233](https://github.com/manuxio/batch-dns-checker/blob/ba4e9a28/server/src/services/batchRunner.ts#L228-L233)
2. **Detection**: Workers check this flag at the start of every iteration [server/src/services/batchRunner.ts154](https://github.com/manuxio/batch-dns-checker/blob/ba4e9a28/server/src/services/batchRunner.ts#L154-L154)
3. **Cleanup**: If cancelled, the remaining `pending` results are transitioned to a `cancelled` status [server/src/services/batchRunner.ts186-194](https://github.com/manuxio/batch-dns-checker/blob/ba4e9a28/server/src/services/batchRunner.ts#L186-L194) and the batch status is set to `stopped`[server/src/services/batchRunner.ts194](https://github.com/manuxio/batch-dns-checker/blob/ba4e9a28/server/src/services/batchRunner.ts#L194-L194)

**Sources:**[server/src/services/batchRunner.ts154](https://github.com/manuxio/batch-dns-checker/blob/ba4e9a28/server/src/services/batchRunner.ts#L154-L154)[server/src/services/batchRunner.ts186-197](https://github.com/manuxio/batch-dns-checker/blob/ba4e9a28/server/src/services/batchRunner.ts#L186-L197)[server/src/services/batchRunner.ts228-233](https://github.com/manuxio/batch-dns-checker/blob/ba4e9a28/server/src/services/batchRunner.ts#L228-L233)

---

## Persistence & Throttling

To prevent the SQLite database from becoming a bottleneck due to rapid updates, `batchRunner.ts` implements throttled persistence.

- **In-Memory Updates**: `active.completed` and `active.counts` are updated immediately in the `ActiveBatch` object [server/src/services/batchRunner.ts162-172](https://github.com/manuxio/batch-dns-checker/blob/ba4e9a28/server/src/services/batchRunner.ts#L162-L172)
- **Throttled Writes**: The `persist()` function, which calls `updateBatchProgress` in the database [server/src/services/batchRunner.ts128-138](https://github.com/manuxio/batch-dns-checker/blob/ba4e9a28/server/src/services/batchRunner.ts#L128-L138) is only executed if more than 1000ms have elapsed since the last write [server/src/services/batchRunner.ts175-178](https://github.com/manuxio/batch-dns-checker/blob/ba4e9a28/server/src/services/batchRunner.ts#L175-L178)
- **Final Write**: A final, non-throttled call to `persist()` is made once all workers finish to ensure the database reflects the 100% completion state [server/src/services/batchRunner.ts200](https://github.com/manuxio/batch-dns-checker/blob/ba4e9a28/server/src/services/batchRunner.ts#L200-L200)

**Sources:**[server/src/services/batchRunner.ts128-138](https://github.com/manuxio/batch-dns-checker/blob/ba4e9a28/server/src/services/batchRunner.ts#L128-L138)[server/src/services/batchRunner.ts174-178](https://github.com/manuxio/batch-dns-checker/blob/ba4e9a28/server/src/services/batchRunner.ts#L174-L178)

---

## Batch Operations

### Rerun Logic

The `rerunBatch(id)` function allows repeating a previous job. It retrieves the source batch (from memory or DB), extracts the original `CheckRow` inputs (hostname, type, expected value), and passes them to `startBatch` to create a brand-new entity with a new UUID [server/src/services/batchRunner.ts209-225](https://github.com/manuxio/batch-dns-checker/blob/ba4e9a28/server/src/services/batchRunner.ts#L209-L225)

### Domain Grouping

For UI presentation, the `groupByDomain` function aggregates flat `HostResult` arrays into `DomainGroup` objects. This groups records by their registrable domain (e.g., `sub.example.com` and `mail.example.com` both fall under `example.com`) [server/src/services/batchRunner.ts260-279](https://github.com/manuxio/batch-dns-checker/blob/ba4e9a28/server/src/services/batchRunner.ts#L260-L279)

**Sources:**[server/src/services/batchRunner.ts209-225](https://github.com/manuxio/batch-dns-checker/blob/ba4e9a28/server/src/services/batchRunner.ts#L209-L225)[server/src/services/batchRunner.ts260-279](https://github.com/manuxio/batch-dns-checker/blob/ba4e9a28/server/src/services/batchRunner.ts#L260-L279)

---

## Key Entities & Functions

| Entity | Type | Role |
| --- | --- | --- |
| `ActiveBatch` | Interface | Defines the in-memory structure for tracking live progress [server/src/services/batchRunner.ts27-42](https://github.com/manuxio/batch-dns-checker/blob/ba4e9a28/server/src/services/batchRunner.ts#L27-L42) |
| `startBatch` | Function | Entry point that initializes state and triggers the async `runBatch`[server/src/services/batchRunner.ts74-126](https://github.com/manuxio/batch-dns-checker/blob/ba4e9a28/server/src/services/batchRunner.ts#L74-L126) |
| `runBatch` | Function | Internal async function managing the worker pool and shared DNS cache [server/src/services/batchRunner.ts140-202](https://github.com/manuxio/batch-dns-checker/blob/ba4e9a28/server/src/services/batchRunner.ts#L140-L202) |
| `tally` | Function | Updates the `BatchCounts` (ok, warning, error, cancelled) based on a result [server/src/services/batchRunner.ts50-64](https://github.com/manuxio/batch-dns-checker/blob/ba4e9a28/server/src/services/batchRunner.ts#L50-L64) |
| `getBatchState` | Function | Helper that checks the `activeBatches` map first, falling back to the DB for historical data [server/src/services/batchRunner.ts254-258](https://github.com/manuxio/batch-dns-checker/blob/ba4e9a28/server/src/services/batchRunner.ts#L254-L258) |

**Sources:**[server/src/services/batchRunner.ts27-42](https://github.com/manuxio/batch-dns-checker/blob/ba4e9a28/server/src/services/batchRunner.ts#L27-L42)[server/src/services/batchRunner.ts50-64](https://github.com/manuxio/batch-dns-checker/blob/ba4e9a28/server/src/services/batchRunner.ts#L50-L64)[server/src/services/batchRunner.ts74-126](https://github.com/manuxio/batch-dns-checker/blob/ba4e9a28/server/src/services/batchRunner.ts#L74-L126)[server/src/services/batchRunner.ts140-202](https://github.com/manuxio/batch-dns-checker/blob/ba4e9a28/server/src/services/batchRunner.ts#L140-L202)[server/src/services/batchRunner.ts254-258](https://github.com/manuxio/batch-dns-checker/blob/ba4e9a28/server/src/services/batchRunner.ts#L254-L258)