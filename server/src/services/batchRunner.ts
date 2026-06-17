import { randomUUID } from 'node:crypto';
import { config } from '../config';
import {
  createBatch,
  getBatch,
  updateBatchProgress,
} from '../db/database';
import { checkHost, createDnsCache } from './dnsChecker';
import { getRegistrableDomain } from '../utils/domain';
import type {
  Batch,
  BatchCounts,
  BatchStatus,
  CheckRow,
  DomainGroup,
  HostResult,
  InvalidRow,
} from '../types';

/**
 * Orchestrates a batch run: checks every expectation with bounded concurrency,
 * persists progress so React can poll, and supports cooperative cancellation.
 * Live (in-flight) batch state is kept in memory; finished batches live in the
 * database.
 */

interface ActiveBatch {
  id: string;
  results: HostResult[];
  counts: BatchCounts;
  completed: number;
  total: number;
  invalidCount: number;
  invalidRows: InvalidRow[];
  status: BatchStatus;
  name: string | null;
  fileName: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  cancelRequested: boolean;
}

const activeBatches = new Map<string, ActiveBatch>();

function emptyCounts(): BatchCounts {
  return { ok: 0, warning: 0, error: 0, cancelled: 0 };
}

function tally(counts: BatchCounts, result: HostResult): void {
  switch (result.status) {
    case 'ok':
      counts.ok += 1;
      break;
    case 'warning':
      counts.warning += 1;
      break;
    case 'cancelled':
      counts.cancelled += 1;
      break;
    default:
      counts.error += 1;
  }
}

export interface StartBatchInput {
  name: string | null;
  fileName: string | null;
  validRows: CheckRow[];
  invalidRows: InvalidRow[];
}

/** Creates and starts a batch; returns its id immediately (runs async). */
export function startBatch(input: StartBatchInput): string {
  const id = randomUUID();
  const createdAt = new Date().toISOString();

  // Pre-seed a pending result entry for every valid row.
  const results: HostResult[] = input.validRows.map((row) => ({
    hostname: row.hostname,
    registrableDomain: getRegistrableDomain(row.hostname),
    type: row.type,
    expectedValue: row.expectedValue,
    zone: null,
    authoritativeNameservers: [],
    nsAnswers: [],
    status: 'pending',
    warnings: [],
  }));

  const total = input.validRows.length + input.invalidRows.length;

  const active: ActiveBatch = {
    id,
    results,
    counts: emptyCounts(),
    completed: input.invalidRows.length,
    total,
    invalidCount: input.invalidRows.length,
    invalidRows: input.invalidRows,
    status: 'pending',
    name: input.name,
    fileName: input.fileName,
    createdAt,
    startedAt: null,
    finishedAt: null,
    cancelRequested: false,
  };
  activeBatches.set(id, active);

  createBatch({
    id,
    name: input.name,
    fileName: input.fileName,
    total,
    invalidCount: input.invalidRows.length,
    invalidRows: input.invalidRows,
    results,
    createdAt,
  });

  // Fire and forget; errors are captured into the batch status.
  void runBatch(active, input.validRows);

  return id;
}

function persist(active: ActiveBatch): void {
  updateBatchProgress({
    id: active.id,
    status: active.status,
    completed: active.completed,
    counts: active.counts,
    startedAt: active.startedAt,
    finishedAt: active.finishedAt,
    results: active.results,
  });
}

async function runBatch(
  active: ActiveBatch,
  rows: CheckRow[],
): Promise<void> {
  active.status = 'running';
  active.startedAt = new Date().toISOString();
  persist(active);

  const cache = createDnsCache();
  let nextIndex = 0;
  let lastPersist = Date.now();

  const worker = async (): Promise<void> => {
    while (true) {
      if (active.cancelRequested) return;
      const index = nextIndex;
      nextIndex += 1;
      if (index >= rows.length) return;

      try {
        const result = await checkHost(rows[index], cache);
        active.results[index] = result;
        tally(active.counts, result);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'unknownError';
        active.results[index] = {
          ...active.results[index],
          status: 'error',
          message,
        };
        active.counts.error += 1;
      }
      active.completed += 1;

      // Throttle persistence to roughly once per second to limit DB writes.
      if (Date.now() - lastPersist > 1000) {
        lastPersist = Date.now();
        persist(active);
      }
    }
  };

  const workerCount = Math.max(1, Math.min(config.hostConcurrency, rows.length));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  // Mark any still-pending entries (cancellation) as cancelled.
  if (active.cancelRequested) {
    for (const result of active.results) {
      if (result.status === 'pending') {
        result.status = 'cancelled';
        active.counts.cancelled += 1;
        active.completed += 1;
      }
    }
    active.status = 'stopped';
  } else {
    active.status = 'completed';
  }

  active.finishedAt = new Date().toISOString();
  persist(active);
  activeBatches.delete(active.id);
}

/**
 * Re-runs an existing batch by cloning its input rows into a brand-new batch
 * (the original is kept; the new one is duplicated into the history). Returns
 * the new batch id, or null if the source batch does not exist.
 */
export function rerunBatch(id: string): string | null {
  const source = getBatchState(id);
  if (!source) return null;

  const validRows: CheckRow[] = source.results.map((result) => ({
    hostname: result.hostname,
    type: result.type,
    expectedValue: result.expectedValue,
  }));

  return startBatch({
    name: source.name,
    fileName: source.fileName,
    validRows,
    invalidRows: source.invalidRows,
  });
}

/** Requests cooperative cancellation of a running batch. */
export function stopBatch(id: string): boolean {
  const active = activeBatches.get(id);
  if (!active) return false;
  active.cancelRequested = true;
  return true;
}

function activeToBatch(active: ActiveBatch): Batch {
  return {
    id: active.id,
    name: active.name,
    fileName: active.fileName,
    status: active.status,
    total: active.total,
    completed: active.completed,
    counts: active.counts,
    invalidCount: active.invalidCount,
    createdAt: active.createdAt,
    startedAt: active.startedAt,
    finishedAt: active.finishedAt,
    results: active.results,
    invalidRows: active.invalidRows,
  };
}

/** Returns live in-memory state if the batch is running, else the DB record. */
export function getBatchState(id: string): Batch | null {
  const active = activeBatches.get(id);
  if (active) return activeToBatch(active);
  return getBatch(id);
}

/** Groups a batch's results by secondary-level (registrable) domain. */
export function groupByDomain(batch: Batch): DomainGroup[] {
  const groups = new Map<string, DomainGroup>();

  for (const result of batch.results) {
    const key = result.registrableDomain;
    let group = groups.get(key);
    if (!group) {
      group = { domain: key, total: 0, counts: emptyCounts(), results: [] };
      groups.set(key, group);
    }
    group.results.push(result);
    group.total += 1;
    tally(group.counts, result);
  }

  return Array.from(groups.values()).sort((a, b) =>
    a.domain.localeCompare(b.domain),
  );
}
