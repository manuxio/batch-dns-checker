import { Router } from 'express';
import {
  isSupportedRecordType,
  normalizeRecordType,
  type RecordType,
} from '../types';
import { isValidHostname } from '../utils/domain';
import {
  checkHost,
  createDnsCache,
  hasMixedOperators,
} from '../services/dnsChecker';

export const checksRouter = Router();

/** POST /api/check - verify a single record synchronously (no persistence). */
checksRouter.post('/', async (req, res) => {
  const hostname = String(req.body?.hostname ?? '').trim();
  const typeRaw = String(req.body?.type ?? '').trim();
  const value = String(req.body?.value ?? '').trim();

  const errors: string[] = [];
  if (!hostname) errors.push('emptyHostname');
  else if (!isValidHostname(hostname)) errors.push('invalidHostname');
  if (!typeRaw) errors.push('emptyType');
  else if (!isSupportedRecordType(typeRaw)) errors.push('unsupportedType');
  if (!value) errors.push('emptyValue');
  else if (hasMixedOperators(value)) errors.push('mixedOperators');

  if (errors.length > 0) {
    res.status(400).json({ error: 'invalidInput', details: { errors } });
    return;
  }

  const result = await checkHost(
    {
      hostname,
      type: normalizeRecordType(typeRaw) as RecordType,
      expectedValue: value,
    },
    createDnsCache(),
  );
  res.json(result);
});
