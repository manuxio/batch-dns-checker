import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { config } from '../config';
import type {
  Batch,
  BatchCounts,
  BatchStatus,
  BatchSummary,
  HostResult,
  InvalidRow,
} from '../types';

/**
 * Persistence layer backed by a single SQLite file on the data volume.
 * Per-host results and invalid rows are stored as JSON blobs; lightweight
 * progress columns are updated independently so polling stays cheap.
 */

fs.mkdirSync(config.dataDir, { recursive: true });
const dbPath = path.join(config.dataDir, 'dns-checker.sqlite');
const db = new Database(dbPath);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS batches (
    id TEXT PRIMARY KEY,
    name TEXT,
    fileName TEXT,
    status TEXT NOT NULL,
    total INTEGER NOT NULL DEFAULT 0,
    completed INTEGER NOT NULL DEFAULT 0,
    okCount INTEGER NOT NULL DEFAULT 0,
    warningCount INTEGER NOT NULL DEFAULT 0,
    errorCount INTEGER NOT NULL DEFAULT 0,
    cancelledCount INTEGER NOT NULL DEFAULT 0,
    invalidCount INTEGER NOT NULL DEFAULT 0,
    createdAt TEXT NOT NULL,
    startedAt TEXT,
    finishedAt TEXT,
    results TEXT NOT NULL DEFAULT '[]',
    invalidRows TEXT NOT NULL DEFAULT '[]'
  );
  CREATE INDEX IF NOT EXISTS idx_batches_createdAt ON batches (createdAt DESC);
`);

interface BatchRow {
  id: string;
  name: string | null;
  fileName: string | null;
  status: BatchStatus;
  total: number;
  completed: number;
  okCount: number;
  warningCount: number;
  errorCount: number;
  cancelledCount: number;
  invalidCount: number;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  results: string;
  invalidRows: string;
}

function rowToSummary(row: BatchRow): BatchSummary {
  return {
    id: row.id,
    name: row.name,
    fileName: row.fileName,
    status: row.status,
    total: row.total,
    completed: row.completed,
    counts: {
      ok: row.okCount,
      warning: row.warningCount,
      error: row.errorCount,
      cancelled: row.cancelledCount,
    },
    invalidCount: row.invalidCount,
    createdAt: row.createdAt,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
  };
}

function rowToBatch(row: BatchRow): Batch {
  return {
    ...rowToSummary(row),
    results: JSON.parse(row.results) as HostResult[],
    invalidRows: JSON.parse(row.invalidRows) as InvalidRow[],
  };
}

const insertStmt = db.prepare(`
  INSERT INTO batches (
    id, name, fileName, status, total, completed,
    okCount, warningCount, errorCount, cancelledCount, invalidCount,
    createdAt, startedAt, finishedAt, results, invalidRows
  ) VALUES (
    @id, @name, @fileName, @status, @total, @completed,
    @okCount, @warningCount, @errorCount, @cancelledCount, @invalidCount,
    @createdAt, @startedAt, @finishedAt, @results, @invalidRows
  )
`);

export interface CreateBatchInput {
  id: string;
  name: string | null;
  fileName: string | null;
  total: number;
  invalidCount: number;
  invalidRows: InvalidRow[];
  results: HostResult[];
  createdAt: string;
}

export function createBatch(input: CreateBatchInput): void {
  insertStmt.run({
    id: input.id,
    name: input.name,
    fileName: input.fileName,
    status: 'pending' as BatchStatus,
    total: input.total,
    completed: input.invalidCount, // invalid rows count as already processed
    okCount: 0,
    warningCount: 0,
    errorCount: 0,
    cancelledCount: 0,
    invalidCount: input.invalidCount,
    createdAt: input.createdAt,
    startedAt: null,
    finishedAt: null,
    results: JSON.stringify(input.results),
    invalidRows: JSON.stringify(input.invalidRows),
  });
  pruneOldBatches();
}

const updateProgressStmt = db.prepare(`
  UPDATE batches SET
    status = @status,
    completed = @completed,
    okCount = @okCount,
    warningCount = @warningCount,
    errorCount = @errorCount,
    cancelledCount = @cancelledCount,
    startedAt = @startedAt,
    finishedAt = @finishedAt,
    results = @results
  WHERE id = @id
`);

export interface UpdateProgressInput {
  id: string;
  status: BatchStatus;
  completed: number;
  counts: BatchCounts;
  startedAt: string | null;
  finishedAt: string | null;
  results: HostResult[];
}

export function updateBatchProgress(input: UpdateProgressInput): void {
  updateProgressStmt.run({
    id: input.id,
    status: input.status,
    completed: input.completed,
    okCount: input.counts.ok,
    warningCount: input.counts.warning,
    errorCount: input.counts.error,
    cancelledCount: input.counts.cancelled,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    results: JSON.stringify(input.results),
  });
}

const getStmt = db.prepare('SELECT * FROM batches WHERE id = ?');
const listStmt = db.prepare(
  'SELECT * FROM batches ORDER BY createdAt DESC LIMIT ?',
);
const deleteStmt = db.prepare('DELETE FROM batches WHERE id = ?');

export function getBatch(id: string): Batch | null {
  const row = getStmt.get(id) as BatchRow | undefined;
  return row ? rowToBatch(row) : null;
}

export function listBatches(limit = config.maxBatches): BatchSummary[] {
  const rows = listStmt.all(limit) as BatchRow[];
  return rows.map(rowToSummary);
}

export function deleteBatch(id: string): boolean {
  return deleteStmt.run(id).changes > 0;
}

/** Keeps only the most recent `maxBatches` batches. */
function pruneOldBatches(): void {
  db.prepare(
    `DELETE FROM batches WHERE id NOT IN (
       SELECT id FROM batches ORDER BY createdAt DESC LIMIT ?
     )`,
  ).run(config.maxBatches);
}

/**
 * On startup, any batch still flagged as running/pending was interrupted by a
 * restart and can never resume, so it is marked accordingly.
 */
export function markStaleBatchesInterrupted(): number {
  const result = db
    .prepare(
      `UPDATE batches SET status = 'interrupted', finishedAt = @now
       WHERE status IN ('running', 'pending')`,
    )
    .run({ now: new Date().toISOString() });
  return result.changes;
}

export { db };
