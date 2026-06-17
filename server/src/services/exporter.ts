import ExcelJS from 'exceljs';
import type { Batch, HostResult } from '../types';

/**
 * Exports a completed batch to XLSX or CSV. Each output row is one expectation
 * and always includes the authoritative nameservers queried plus the per-NS
 * outcome, so the downloaded result is self-contained and auditable.
 */

const HEADERS = [
  'secondaryLevelDomain',
  'hostname',
  'type',
  'expectedValue',
  'status',
  'warnings',
  'zone',
  'authoritativeNameservers',
  'nameserverDetails',
  'message',
];

function formatNsDetails(result: HostResult): string {
  return result.nsAnswers
    .map((a) => {
      const where = a.nsIp ? `${a.nsName} (${a.nsIp})` : a.nsName;
      const returned = a.returnedValues.length
        ? a.returnedValues.join(' | ')
        : '-';
      const err = a.error ? ` err=${a.error}` : '';
      return `${where} => ${a.status}: ${returned}${err}`;
    })
    .join('\n');
}

function toMatrix(batch: Batch): string[][] {
  const rows: string[][] = [HEADERS];

  for (const result of batch.results) {
    rows.push([
      result.registrableDomain,
      result.hostname,
      result.type,
      result.expectedValue,
      result.status,
      result.warnings.join(', '),
      result.zone ?? '',
      result.authoritativeNameservers.join(', '),
      formatNsDetails(result),
      result.message ?? '',
    ]);
  }

  // Append invalid rows so nothing is silently dropped from the export.
  for (const invalid of batch.invalidRows) {
    rows.push([
      '',
      String(invalid.raw.hostname ?? invalid.raw.host ?? ''),
      String(invalid.raw.type ?? ''),
      String(invalid.raw.value ?? ''),
      'invalid',
      invalid.error,
      '',
      '',
      `row ${invalid.rowNumber}`,
      'invalidInputRow',
    ]);
  }

  return rows;
}

export async function exportBatchXlsx(batch: Batch): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('results');
  for (const row of toMatrix(batch)) sheet.addRow(row);
  sheet.columns = [
    { width: 24 },
    { width: 30 },
    { width: 8 },
    { width: 30 },
    { width: 10 },
    { width: 28 },
    { width: 22 },
    { width: 36 },
    { width: 60 },
    { width: 24 },
  ];
  sheet.getRow(1).font = { bold: true };
  // Wrap the multi-line per-nameserver detail column for readability.
  sheet.getColumn(9).alignment = { wrapText: true, vertical: 'top' };
  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

export function exportBatchCsv(batch: Batch): string {
  const matrix = toMatrix(batch);
  return matrix
    .map((row) =>
      row
        .map((cell) => {
          const value = String(cell ?? '');
          return /[",;\n\r]/.test(value)
            ? `"${value.replace(/"/g, '""')}"`
            : value;
        })
        .join(','),
    )
    .join('\r\n');
}
