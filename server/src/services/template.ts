import ExcelJS from 'exceljs';

/**
 * Demo template made available for download so users know the exact expected
 * input layout. Header row + a few illustrative rows covering several types.
 */

const TEMPLATE_HEADERS = ['hostname', 'type', 'value'];

const TEMPLATE_ROWS: Array<[string, string, string]> = [
  // --- Basic records ---
  ['www.example.it', 'A', '93.184.216.34'],
  ['www.example.it', 'AAAA', '2606:2800:220:1:248:1893:25c8:1946'],
  ['example.it', 'MX', '10 mail.example.it'],
  ['_sip._tcp.example.it', 'SRV', '10 60 5060 sip.example.it'],
  ['example.it', 'CAA', '0 issue letsencrypt.org'],

  // --- CNAME (alias). The value is the canonical target the name points to.
  // A CNAME name cannot coexist with other records, and is often a chain. ---
  ['shop.example.it', 'CNAME', 'www.example.it'],
  ['cdn.example.it', 'CNAME', 'example.it.cdn.cloudflare.net'],

  // --- Compound values ---
  // "a & b": BOTH required (extra records allowed -> warning).
  ['example.it', 'NS', 'ns1.example.it & ns2.example.it'],
  ['api.example.it', 'A', '203.0.113.10 & 203.0.113.11'],
  // "a | b": at least ONE present AND only these values allowed.
  ['cluster.example.it', 'A', '203.0.113.20 | 203.0.113.21'],

  // --- Email / policy records (TXT under conventional names) ---
  ['example.it', 'SPF', 'v=spf1 include:_spf.example.it -all'],
  ['example.it', 'DMARC', 'v=DMARC1; p=reject; rua=mailto:dmarc@example.it'],
  // DKIM: put the full selector name in the hostname column.
  ['sel1._domainkey.example.it', 'DKIM', 'v=DKIM1; k=rsa; p=MIGfMA0GCSqGSI...'],
  ['example.it', 'MTA-STS', 'v=STSv1; id=20240101000000Z'],
  ['example.it', 'TLS-RPT', 'v=TLSRPTv1; rua=mailto:tlsrpt@example.it'],
  ['example.it', 'BIMI', 'v=BIMI1; l=https://example.it/logo.svg'],
  // Plain TXT (verification token, etc.)
  ['example.it', 'TXT', 'google-site-verification=AbCdEf123'],
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
