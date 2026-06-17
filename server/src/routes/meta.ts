import { Router } from 'express';
import { config } from '../config';
import { SUPPORTED_RECORD_TYPES } from '../types';
import { buildTemplateCsv, buildTemplateXlsx } from '../services/template';

export const metaRouter = Router();

const APP_NAME = 'CONI SVC DNS Checker';
const APP_VERSION = '1.0.0';

/** GET /api/health */
metaRouter.get('/health', (_req, res) => {
  res.json({ status: 'ok', name: APP_NAME, version: APP_VERSION });
});

/** GET /api/record-types */
metaRouter.get('/record-types', (_req, res) => {
  res.json({ recordTypes: SUPPORTED_RECORD_TYPES });
});

/** GET /api/config - non-sensitive client configuration. */
metaRouter.get('/config', (_req, res) => {
  res.json({
    appName: APP_NAME,
    version: APP_VERSION,
    recordTypes: SUPPORTED_RECORD_TYPES,
    softMaxRecords: config.softMaxRecords,
    maxBatches: config.maxBatches,
    maxUploadBytes: config.maxUploadBytes,
    dnsMaxRetries: config.dnsMaxRetries,
  });
});

/** GET /api/template?format=xlsx|csv */
metaRouter.get('/template', async (req, res) => {
  const format = req.query.format === 'csv' ? 'csv' : 'xlsx';
  if (format === 'csv') {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      'attachment; filename="dns-checker-template.csv"',
    );
    res.send('﻿' + buildTemplateCsv());
    return;
  }
  res.setHeader(
    'Content-Type',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  );
  res.setHeader(
    'Content-Disposition',
    'attachment; filename="dns-checker-template.xlsx"',
  );
  res.send(await buildTemplateXlsx());
});
