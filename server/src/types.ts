/**
 * DNS record types supported by the checker: the broad standard set plus
 * "policy" pseudo-types (SPF/DKIM/DMARC/MTA-STS/TLS-RPT/BIMI) that map to TXT
 * records at conventional names.
 */
export const SUPPORTED_RECORD_TYPES = [
  'A',
  'AAAA',
  'CNAME',
  'MX',
  'TXT',
  'NS',
  'SRV',
  'CAA',
  'SPF',
  'DKIM',
  'DMARC',
  'MTASTS',
  'TLSRPT',
  'BIMI',
] as const;

export type RecordType = (typeof SUPPORTED_RECORD_TYPES)[number];

/** Normalizes user-typed record types, accepting hyphenated aliases. */
export function normalizeRecordType(value: string): string {
  return value.trim().toUpperCase().replace(/[-_\s]/g, '');
}

export function isSupportedRecordType(value: string): value is RecordType {
  return (SUPPORTED_RECORD_TYPES as readonly string[]).includes(
    normalizeRecordType(value),
  );
}

/** Match mode derived from the compound-value operators ('&' / '|'). */
export type MatchMode = 'single' | 'all' | 'any';

/** A single expectation read from the uploaded file: one row = one check. */
export interface CheckRow {
  hostname: string;
  type: RecordType;
  expectedValue: string;
}

/** A row that failed validation while parsing the uploaded file. */
export interface InvalidRow {
  rowNumber: number;
  raw: Record<string, unknown>;
  error: string;
}

export type NsAnswerStatus = 'ok' | 'mismatch' | 'error' | 'timeout';

/** Result of querying one authoritative nameserver for one expectation. */
export interface NsAnswer {
  nsName: string;
  nsIp: string | null;
  status: NsAnswerStatus;
  /** Normalized values returned by this nameserver. */
  returnedValues: string[];
  /** Returned values not covered by the expectation (only when contains-match). */
  extraValues: string[];
  error?: string;
}

export type HostResultStatus = 'pending' | 'ok' | 'warning' | 'error' | 'cancelled';

/** Aggregated outcome for one expectation across all authoritative servers. */
export interface HostResult {
  hostname: string;
  /** Actual FQDN queried (differs from hostname for policy types, e.g. _dmarc.). */
  queryName?: string;
  /** Registrable (secondary-level) domain, used as the grouping key. */
  registrableDomain: string;
  type: RecordType;
  expectedValue: string;
  /** Compound-value match mode derived from '&' / '|' operators. */
  matchMode?: MatchMode;
  /** Zone whose authoritative nameservers were queried. */
  zone: string | null;
  authoritativeNameservers: string[];
  nsAnswers: NsAnswer[];
  status: HostResultStatus;
  /** Human-readable warnings (extra records, inconsistencies between NS, ...). */
  warnings: string[];
  message?: string;
}

export type BatchStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'stopped'
  | 'interrupted'
  | 'error';

export interface BatchCounts {
  ok: number;
  warning: number;
  error: number;
  cancelled: number;
}

/** Lightweight batch metadata (no per-host results). */
export interface BatchSummary {
  id: string;
  name: string | null;
  fileName: string | null;
  status: BatchStatus;
  total: number;
  completed: number;
  counts: BatchCounts;
  invalidCount: number;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

/** Full batch payload, including per-host results and invalid rows. */
export interface Batch extends BatchSummary {
  results: HostResult[];
  invalidRows: InvalidRow[];
}

/** Results grouped by secondary-level (registrable) domain. */
export interface DomainGroup {
  domain: string;
  total: number;
  counts: BatchCounts;
  results: HostResult[];
}
