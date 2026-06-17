import Papa from 'papaparse';
import ExcelJS from 'exceljs';
import { isSupportedRecordType, type CheckRow, type InvalidRow } from '../types';
import { isValidHostname } from '../utils/domain';

/**
 * Parses an uploaded CSV/XLSX file into validated check rows. The expected
 * layout is a header row with the columns: hostname, type, value (any order,
 * case-insensitive). CSV delimiter (comma or semicolon) is auto-detected.
 */

export interface ParseResult {
  validRows: CheckRow[];
  invalidRows: InvalidRow[];
}

const COLUMN_ALIASES: Record<string, string[]> = {
  hostname: ['hostname', 'host', 'fqdn', 'name', 'nome'],
  type: ['type', 'tipo', 'record', 'recordtype'],
  value: ['value', 'valore', 'expectedvalue', 'atteso'],
};

function normalizeHeader(header: string): string {
  return header.trim().toLowerCase().replace(/[\s_-]/g, '');
}

/** Maps actual file headers to our canonical column keys. */
function resolveColumnMap(headers: string[]): {
  map: Partial<Record<'hostname' | 'type' | 'value', string>>;
  missing: string[];
} {
  const normalizedHeaders = headers.map((h) => ({
    original: h,
    normalized: normalizeHeader(h),
  }));
  const map: Partial<Record<'hostname' | 'type' | 'value', string>> = {};

  for (const canonical of ['hostname', 'type', 'value'] as const) {
    const aliases = COLUMN_ALIASES[canonical].map(normalizeHeader);
    const found = normalizedHeaders.find((h) => aliases.includes(h.normalized));
    if (found) map[canonical] = found.original;
  }

  const missing = (['hostname', 'type', 'value'] as const).filter(
    (key) => !map[key],
  );
  return { map, missing };
}

export class FileParseError extends Error {}

function rowsToResult(
  records: Record<string, unknown>[],
  headers: string[],
): ParseResult {
  const { map, missing } = resolveColumnMap(headers);
  if (missing.length > 0) {
    throw new FileParseError(
      `Missing required column(s): ${missing.join(', ')}. Expected: hostname, type, value.`,
    );
  }

  const validRows: CheckRow[] = [];
  const invalidRows: InvalidRow[] = [];

  records.forEach((record, index) => {
    const rowNumber = index + 2; // +1 for header, +1 for 1-based indexing
    const hostname = String(record[map.hostname!] ?? '').trim();
    const typeRaw = String(record[map.type!] ?? '').trim();
    const value = String(record[map.value!] ?? '').trim();

    // Skip fully empty rows silently.
    if (!hostname && !typeRaw && !value) return;

    const errors: string[] = [];
    if (!hostname) errors.push('emptyHostname');
    else if (!isValidHostname(hostname)) errors.push('invalidHostname');
    if (!typeRaw) errors.push('emptyType');
    else if (!isSupportedRecordType(typeRaw)) errors.push('unsupportedType');
    if (!value) errors.push('emptyValue');

    if (errors.length > 0) {
      invalidRows.push({ rowNumber, raw: record, error: errors.join(', ') });
      return;
    }

    validRows.push({
      hostname,
      type: typeRaw.toUpperCase() as CheckRow['type'],
      expectedValue: value,
    });
  });

  return { validRows, invalidRows };
}

function parseCsv(buffer: Buffer): ParseResult {
  const text = buffer.toString('utf8').replace(/^﻿/, '');
  const parsed = Papa.parse<Record<string, unknown>>(text, {
    header: true,
    skipEmptyLines: 'greedy',
    transformHeader: (h) => h.trim(),
    delimiter: '', // auto-detect (handles comma and semicolon)
  });

  if (parsed.errors.length > 0) {
    const fatal = parsed.errors.find((e) => e.type === 'Delimiter');
    if (fatal) throw new FileParseError(fatal.message);
  }

  const headers = parsed.meta.fields ?? [];
  return rowsToResult(parsed.data, headers);
}

async function parseExcel(buffer: Buffer): Promise<ParseResult> {
  const workbook = new ExcelJS.Workbook();
  // Cast around the Node "generic Buffer" typing mismatch with exceljs.
  await workbook.xlsx.load(
    buffer as unknown as Parameters<typeof workbook.xlsx.load>[0],
  );
  const sheet = workbook.worksheets[0];
  if (!sheet) throw new FileParseError('emptyWorkbook');

  // Map column index -> trimmed header name from the first row.
  const headerByCol = new Map<number, string>();
  const headers: string[] = [];
  sheet.getRow(1).eachCell({ includeEmpty: false }, (cell, colNumber) => {
    const name = String(cell.text ?? '').trim();
    if (name) {
      headerByCol.set(colNumber, name);
      headers.push(name);
    }
  });

  const records: Record<string, unknown>[] = [];
  for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber += 1) {
    const row = sheet.getRow(rowNumber);
    const record: Record<string, unknown> = {};
    let hasContent = false;
    headerByCol.forEach((name, colNumber) => {
      const text = String(row.getCell(colNumber).text ?? '').trim();
      record[name] = text;
      if (text !== '') hasContent = true;
    });
    if (hasContent) records.push(record);
  }

  return rowsToResult(records, headers);
}

/** Dispatches to the right parser based on file name / mimetype. */
export async function parseUpload(
  buffer: Buffer,
  originalName: string,
  mimeType?: string,
): Promise<ParseResult> {
  const lower = originalName.toLowerCase();
  const isExcel =
    lower.endsWith('.xlsx') ||
    lower.endsWith('.xls') ||
    mimeType ===
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
    mimeType === 'application/vnd.ms-excel';

  if (isExcel) return parseExcel(buffer);

  // CSV (and fallback for unknown/text types).
  return parseCsv(buffer);
}
