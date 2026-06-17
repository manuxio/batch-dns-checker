import ExcelJS from 'exceljs';

/**
 * Demo template made available for download so users know the exact expected
 * input layout. Header row + a few illustrative rows covering several types.
 */

const TEMPLATE_HEADERS = ['hostname', 'type', 'value'];

const TEMPLATE_ROWS: Array<[string, string, string]> = [
  ['www.example.it', 'A', '93.184.216.34'],
  ['www.example.it', 'AAAA', '2606:2800:220:1:248:1893:25c8:1946'],
  ['shop.example.it', 'CNAME', 'www.example.it'],
  ['example.it', 'MX', '10 mail.example.it'],
  ['example.it', 'TXT', 'v=spf1 include:_spf.example.it -all'],
  ['example.it', 'NS', 'ns1.example.it'],
  ['_sip._tcp.example.it', 'SRV', '10 60 5060 sip.example.it'],
  ['example.it', 'CAA', '0 issue letsencrypt.org'],
];

export function buildTemplateCsv(): string {
  const lines = [TEMPLATE_HEADERS.join(',')];
  for (const row of TEMPLATE_ROWS) {
    // Quote values that contain a comma or space to stay CSV-safe.
    lines.push(
      row
        .map((cell) => (/[",;\s]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell))
        .join(','),
    );
  }
  return lines.join('\r\n') + '\r\n';
}

export async function buildTemplateXlsx(): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('template');
  sheet.addRow(TEMPLATE_HEADERS);
  for (const row of TEMPLATE_ROWS) sheet.addRow(row);
  sheet.columns = [{ width: 26 }, { width: 8 }, { width: 44 }];
  sheet.getRow(1).font = { bold: true };
  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}
