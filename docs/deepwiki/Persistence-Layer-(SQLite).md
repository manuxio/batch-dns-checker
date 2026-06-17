# Persistence Layer (SQLite)
Relevant source files
- [.gitignore](https://github.com/manuxio/batch-dns-checker/blob/ba4e9a28/.gitignore)
- [server/.dockerignore](https://github.com/manuxio/batch-dns-checker/blob/ba4e9a28/server/.dockerignore)
- [server/src/config.ts](https://github.com/manuxio/batch-dns-checker/blob/ba4e9a28/server/src/config.ts)
- [server/src/db/database.ts](https://github.com/manuxio/batch-dns-checker/blob/ba4e9a28/server/src/db/database.ts)
- [server/src/services/batchRunner.ts](https://github.com/manuxio/batch-dns-checker/blob/ba4e9a28/server/src/services/batchRunner.ts)

The persistence layer of the DNS Checker is built on **SQLite**, providing a lightweight, file-based relational storage system. It is designed to handle asynchronous batch processing by storing metadata, progress counters, and detailed result sets.

## Database Configuration

The database is initialized using the `better-sqlite3` library. It resides in a single file named `dns-checker.sqlite` within the directory specified by the `DATA_DIR` environment variable [server/src/db/database.ts20-21](https://github.com/manuxio/batch-dns-checker/blob/ba4e9a28/server/src/db/database.ts#L20-L21)

### Performance and Integrity

To ensure high performance during concurrent read/write operations (common when polling batch status while workers are writing results), the database uses **Write-Ahead Logging (WAL)** mode [server/src/db/database.ts24](https://github.com/manuxio/batch-dns-checker/blob/ba4e9a28/server/src/db/database.ts#L24-L24) Foreign key constraints are also enforced [server/src/db/database.ts25](https://github.com/manuxio/batch-dns-checker/blob/ba4e9a28/server/src/db/database.ts#L25-L25)

### Schema: The `batches` Table

The core of the persistence layer is the `batches` table. It stores both flat metadata and complex nested data (results and invalid rows) as JSON strings [server/src/db/database.ts14-18](https://github.com/manuxio/batch-dns-checker/blob/ba4e9a28/server/src/db/database.ts#L14-L18)

| Column | Type | Description |
| --- | --- | --- |
| `id` | TEXT | Primary Key (UUID) |
| `name` | TEXT | Optional user-provided name for the batch |
| `fileName` | TEXT | Original name of the uploaded file |
| `status` | TEXT | `pending`, `running`, `completed`, `stopped`, or `interrupted` |
| `total` | INTEGER | Total number of rows (valid + invalid) |
| `completed` | INTEGER | Number of rows processed |
| `okCount` | INTEGER | Counter for 'ok' results |
| `warningCount` | INTEGER | Counter for 'warning' results |
| `errorCount` | INTEGER | Counter for 'error' results |
| `cancelledCount` | INTEGER | Counter for rows cancelled by user |
| `invalidCount` | INTEGER | Count of rows that failed initial parsing |
| `createdAt` | TEXT | ISO timestamp of creation (Indexed) |
| `results` | TEXT | JSON blob of `HostResult[]` |
| `invalidRows` | TEXT | JSON blob of `InvalidRow[]` |

**Sources:**[server/src/db/database.ts27-47](https://github.com/manuxio/batch-dns-checker/blob/ba4e9a28/server/src/db/database.ts#L27-L47)

## Data Flow: Persistence Lifecycle

The following diagram illustrates how the `batchRunner.ts` interacts with `database.ts` during the lifecycle of a DNS check batch.

**Batch Persistence Logic**

**Sources:**[server/src/services/batchRunner.ts128-138](https://github.com/manuxio/batch-dns-checker/blob/ba4e9a28/server/src/services/batchRunner.ts#L128-L138)[server/src/services/batchRunner.ts174-178](https://github.com/manuxio/batch-dns-checker/blob/ba4e9a28/server/src/services/batchRunner.ts#L174-L178)[server/src/db/database.ts120-140](https://github.com/manuxio/batch-dns-checker/blob/ba4e9a28/server/src/db/database.ts#L120-L140)[server/src/db/database.ts166-179](https://github.com/manuxio/batch-dns-checker/blob/ba4e9a28/server/src/db/database.ts#L166-L179)

## Key Functions

### Batch Management

- **`createBatch(input: CreateBatchInput)`**: Inserts a new record. It initializes `completed` with the `invalidCount`, as invalid rows require no DNS resolution [server/src/db/database.ts120-127](https://github.com/manuxio/batch-dns-checker/blob/ba4e9a28/server/src/db/database.ts#L120-L127)
- **`updateBatchProgress(input: UpdateProgressInput)`**: Updates the dynamic state of a running batch, including counters and the serialized `results` array [server/src/db/database.ts166-179](https://github.com/manuxio/batch-dns-checker/blob/ba4e9a28/server/src/db/database.ts#L166-L179)
- **`getBatch(id: string)`**: Retrieves a full batch record and parses JSON blobs back into TypeScript objects [server/src/db/database.ts187-190](https://github.com/manuxio/batch-dns-checker/blob/ba4e9a28/server/src/db/database.ts#L187-L190)
- **`listBatches(limit)`**: Returns an array of `BatchSummary` objects (excluding the heavy `results` and `invalidRows` blobs) for the history UI [server/src/db/database.ts192-195](https://github.com/manuxio/batch-dns-checker/blob/ba4e9a28/server/src/db/database.ts#L192-L195)
- **`deleteBatch(id: string)`**: Removes a batch record from the database [server/src/db/database.ts197-199](https://github.com/manuxio/batch-dns-checker/blob/ba4e9a28/server/src/db/database.ts#L197-L199)

### Retention Policy: `pruneOldBatches`

To prevent unbounded disk usage, the system enforces a retention policy defined by `config.maxBatches` (default: 10) [server/src/config.ts35](https://github.com/manuxio/batch-dns-checker/blob/ba4e9a28/server/src/config.ts#L35-L35) Every time a new batch is created, `pruneOldBatches` is called to delete the oldest records exceeding this limit [server/src/db/database.ts202-208](https://github.com/manuxio/batch-dns-checker/blob/ba4e9a28/server/src/db/database.ts#L202-L208)

### Startup Recovery: `markStaleBatchesInterrupted`

Because active batch state is partially held in memory within `batchRunner.ts`[server/src/services/batchRunner.ts44](https://github.com/manuxio/batch-dns-checker/blob/ba4e9a28/server/src/services/batchRunner.ts#L44-L44) a server crash or restart would leave batches in a perpetual `running` or `pending` state in the database.

On application startup, the server calls `markStaleBatchesInterrupted()`, which transitions any such records to the `interrupted` status and sets their `finishedAt` timestamp [server/src/db/database.ts214-222](https://github.com/manuxio/batch-dns-checker/blob/ba4e9a28/server/src/db/database.ts#L214-L222)

**Sources:**[server/src/db/database.ts139](https://github.com/manuxio/batch-dns-checker/blob/ba4e9a28/server/src/db/database.ts#L139-L139)[server/src/db/database.ts202-208](https://github.com/manuxio/batch-dns-checker/blob/ba4e9a28/server/src/db/database.ts#L202-L208)[server/src/db/database.ts214-222](https://github.com/manuxio/batch-dns-checker/blob/ba4e9a28/server/src/db/database.ts#L214-L222)

## Code Entity Mapping

The following diagram maps the logical persistence operations to the internal `better-sqlite3` statement handles used in `database.ts`.

**Database Internal Mapping**

**Sources:**[server/src/db/database.ts97-107](https://github.com/manuxio/batch-dns-checker/blob/ba4e9a28/server/src/db/database.ts#L97-L107)[server/src/db/database.ts142-154](https://github.com/manuxio/batch-dns-checker/blob/ba4e9a28/server/src/db/database.ts#L142-L154)[server/src/db/database.ts182-184](https://github.com/manuxio/batch-dns-checker/blob/ba4e9a28/server/src/db/database.ts#L182-L184)[server/src/db/database.ts215-220](https://github.com/manuxio/batch-dns-checker/blob/ba4e9a28/server/src/db/database.ts#L215-L220)