import { Router } from 'express';
import multer from 'multer';
import { config } from '../config';
import { deleteBatch, listBatches } from '../db/database';
import {
  getBatchState,
  groupByDomain,
  startBatch,
  stopBatch,
} from '../services/batchRunner';
import { FileParseError, parseUpload } from '../services/fileParser';
import { exportBatchCsv, exportBatchXlsx } from '../services/exporter';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.maxUploadBytes },
});

export const batchesRouter = Router();

/** GET /api/batches - list recent batches (max 10). */
batchesRouter.get('/', (_req, res) => {
  res.json({ batches: listBatches() });
});

/** POST /api/batches - upload a file and start a batch. */
batchesRouter.post('/', upload.single('file'), async (req, res) => {
  if (!req.file) {
    res.status(400).json({ error: 'noFileUploaded' });
    return;
  }

  let parsed;
  try {
    parsed = await parseUpload(
      req.file.buffer,
      req.file.originalname,
      req.file.mimetype,
    );
  } catch (err) {
    const message = err instanceof FileParseError ? err.message : 'parseFailed';
    res.status(400).json({ error: 'parseFailed', details: { message } });
    return;
  }

  if (parsed.validRows.length === 0) {
    res.status(400).json({
      error: 'noValidRows',
      details: { invalidCount: parsed.invalidRows.length },
    });
    return;
  }

  const name =
    typeof req.body?.name === 'string' && req.body.name.trim().length > 0
      ? req.body.name.trim()
      : null;

  const id = startBatch({
    name,
    fileName: req.file.originalname,
    validRows: parsed.validRows,
    invalidRows: parsed.invalidRows,
  });

  const batch = getBatchState(id);
  // Soft limit: large batches are accepted but flagged so the UI can warn.
  const warning =
    parsed.validRows.length > config.softMaxRecords
      ? 'softLimitExceeded'
      : undefined;
  res.status(201).json({ ...batch, warning, softMaxRecords: config.softMaxRecords });
});

/** GET /api/batches/:id - full batch with results. */
batchesRouter.get('/:id', (req, res) => {
  const batch = getBatchState(req.params.id);
  if (!batch) {
    res.status(404).json({ error: 'batchNotFound' });
    return;
  }
  res.json(batch);
});

/** GET /api/batches/:id/status - lightweight progress for polling. */
batchesRouter.get('/:id/status', (req, res) => {
  const batch = getBatchState(req.params.id);
  if (!batch) {
    res.status(404).json({ error: 'batchNotFound' });
    return;
  }
  res.json({
    id: batch.id,
    status: batch.status,
    total: batch.total,
    completed: batch.completed,
    counts: batch.counts,
  });
});

/** GET /api/batches/:id/groups - results grouped by secondary-level domain. */
batchesRouter.get('/:id/groups', (req, res) => {
  const batch = getBatchState(req.params.id);
  if (!batch) {
    res.status(404).json({ error: 'batchNotFound' });
    return;
  }
  res.json({ groups: groupByDomain(batch) });
});

/** POST /api/batches/:id/stop - request cancellation. */
batchesRouter.post('/:id/stop', (req, res) => {
  const stopped = stopBatch(req.params.id);
  if (!stopped) {
    res.status(404).json({ error: 'noRunningBatch' });
    return;
  }
  res.status(202).json({ id: req.params.id, status: 'stopRequested' });
});

/** DELETE /api/batches/:id - remove a batch. */
batchesRouter.delete('/:id', (req, res) => {
  const removed = deleteBatch(req.params.id);
  if (!removed) {
    res.status(404).json({ error: 'batchNotFound' });
    return;
  }
  res.status(204).end();
});

/** GET /api/batches/:id/export?format=xlsx|csv - download results. */
batchesRouter.get('/:id/export', async (req, res) => {
  const batch = getBatchState(req.params.id);
  if (!batch) {
    res.status(404).json({ error: 'batchNotFound' });
    return;
  }

  const format = req.query.format === 'csv' ? 'csv' : 'xlsx';
  const safeName = (batch.name ?? batch.id).replace(/[^a-z0-9_-]+/gi, '_');
  const fileBase = `dns-check_${safeName}`;

  if (format === 'csv') {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${fileBase}.csv"`,
    );
    res.send('﻿' + exportBatchCsv(batch)); // BOM for Excel compatibility
    return;
  }

  res.setHeader(
    'Content-Type',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  );
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${fileBase}.xlsx"`,
  );
  res.send(await exportBatchXlsx(batch));
});
