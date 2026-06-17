# Batch Processing System
Relevant source files
- [README.md](https://github.com/manuxio/batch-dns-checker/blob/ba4e9a28/README.md?plain=1)
- [server/src/services/batchRunner.ts](https://github.com/manuxio/batch-dns-checker/blob/ba4e9a28/server/src/services/batchRunner.ts)
- [server/src/services/fileParser.ts](https://github.com/manuxio/batch-dns-checker/blob/ba4e9a28/server/src/services/fileParser.ts)

The **Batch Processing System** is the core orchestration layer of the application. It manages the transformation of uploaded files (CSV/XLSX) into asynchronous, trackable jobs that execute DNS compliance checks at scale. The system is designed to be resilient, providing live progress updates via polling, supporting cooperative cancellation, and persisting results for historical consultation.

### System Architecture Overview

The lifecycle of a batch job follows a linear path from ingestion to persistence:

1. **Ingestion**: `fileParser.ts` validates the file structure and content.
2. **Orchestration**: `batchRunner.ts` initializes an `ActiveBatch` and manages the worker pool.
3. **Execution**: The `Core DNS Engine` performs the actual resolution for each row.
4. **Persistence**: `database.ts` stores state transitions and final results in SQLite.

#### Data Flow: File to Batch Job

This diagram maps the transition from the "Natural Language" domain of user files to the internal "Code Entity" representations.

Sources: [server/src/services/fileParser.ts18-21](https://github.com/manuxio/batch-dns-checker/blob/ba4e9a28/server/src/services/fileParser.ts#L18-L21)[server/src/services/fileParser.ts159-176](https://github.com/manuxio/batch-dns-checker/blob/ba4e9a28/server/src/services/fileParser.ts#L159-L176)[server/src/services/batchRunner.ts74-126](https://github.com/manuxio/batch-dns-checker/blob/ba4e9a28/server/src/services/batchRunner.ts#L74-L126)[server/src/services/batchRunner.ts27-42](https://github.com/manuxio/batch-dns-checker/blob/ba4e9a28/server/src/services/batchRunner.ts#L27-L42)

---

### File Parsing & Input Validation

The system supports CSV and Excel (`.xlsx`, `.xls`) formats. It uses a flexible column-alias system to identify required fields (`hostname`, `type`, `value`) regardless of the specific header names used (e.g., "FQDN" or "Nome").

- **Validation**: Every row is checked for host validity, supported DNS types, and operator consistency.
- **Error Handling**: Rows that fail validation are separated into an `invalidRows` array and are not processed by the DNS engine but are stored in the batch record for user feedback.

For details, see [File Parsing & Input Validation](/manuxio/batch-dns-checker/3.1-file-parsing-and-input-validation).

Sources: [server/src/services/fileParser.ts23-27](https://github.com/manuxio/batch-dns-checker/blob/ba4e9a28/server/src/services/fileParser.ts#L23-L27)[server/src/services/fileParser.ts81-92](https://github.com/manuxio/batch-dns-checker/blob/ba4e9a28/server/src/services/fileParser.ts#L81-L92)

---

### Batch Runner & Concurrency

Once a file is parsed, the `batchRunner` orchestrates the execution using a worker-pool pattern.

- **Concurrency**: Controlled by the `DNS_HOST_CONCURRENCY` environment variable (defaulting to 10).
- **State Management**: In-flight batches are stored in an internal `activeBatches` Map for fast access during polling.
- **Throttling**: To prevent database I/O bottlenecks, progress is persisted to SQLite at a throttled interval (approx. once per second).
- **Cancellation**: Supports `stopBatch()` which sets a `cancelRequested` flag, allowing workers to exit gracefully.

For details, see [Batch Runner & Concurrency](/manuxio/batch-dns-checker/3.2-batch-runner-and-concurrency).

#### Concurrency and State Diagram

This diagram shows how the `batchRunner.ts` manages multiple concurrent workers and updates the `database.ts`.

Sources: [server/src/services/batchRunner.ts44](https://github.com/manuxio/batch-dns-checker/blob/ba4e9a28/server/src/services/batchRunner.ts#L44-L44)[server/src/services/batchRunner.ts152-183](https://github.com/manuxio/batch-dns-checker/blob/ba4e9a28/server/src/services/batchRunner.ts#L152-L183)[server/src/services/batchRunner.ts174-178](https://github.com/manuxio/batch-dns-checker/blob/ba4e9a28/server/src/services/batchRunner.ts#L174-L178)

---

### Persistence Layer (SQLite)

The application uses SQLite with Write-Ahead Logging (WAL) enabled for performance.

- **Retention**: The system automatically prunes old batches to keep only the most recent records (configured via `MAX_BATCHES`).
- **Recovery**: On startup, the system calls `markStaleBatchesInterrupted()` to ensure that any batches left in a 'running' state (due to a crash or restart) are marked as 'interrupted'.

For details, see [Persistence Layer (SQLite)](/manuxio/batch-dns-checker/3.3-persistence-layer-(sqlite)).

Sources: [server/src/db/database.ts1-20](https://github.com/manuxio/batch-dns-checker/blob/ba4e9a28/server/src/db/database.ts#L1-L20) (implied schema), [server/src/services/batchRunner.ts111-120](https://github.com/manuxio/batch-dns-checker/blob/ba4e9a28/server/src/services/batchRunner.ts#L111-L120)

---

### Export & Templates

Users can export completed or stopped batches back into XLSX or CSV formats. The export includes expanded details, such as the specific results from every authoritative nameserver queried. Additionally, the system provides static templates to ensure users can easily format their input files.

For details, see [Export & Templates](/manuxio/batch-dns-checker/3.4-export-and-templates).

Sources: [server/src/services/batchRunner.ts260-278](https://github.com/manuxio/batch-dns-checker/blob/ba4e9a28/server/src/services/batchRunner.ts#L260-L278) (grouping logic for export)