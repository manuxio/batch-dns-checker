// Shapes mirrored from the backend API (kept in sync manually).

export type RecordType =
  | 'A'
  | 'AAAA'
  | 'CNAME'
  | 'MX'
  | 'TXT'
  | 'NS'
  | 'SRV'
  | 'CAA';

export type NsAnswerStatus = 'ok' | 'mismatch' | 'error' | 'timeout';
export type HostResultStatus =
  | 'pending'
  | 'ok'
  | 'warning'
  | 'error'
  | 'cancelled';
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

export interface NsAnswer {
  nsName: string;
  nsIp: string | null;
  status: NsAnswerStatus;
  returnedValues: string[];
  extraValues: string[];
  error?: string;
}

export interface HostResult {
  hostname: string;
  registrableDomain: string;
  type: RecordType;
  expectedValue: string;
  zone: string | null;
  authoritativeNameservers: string[];
  nsAnswers: NsAnswer[];
  status: HostResultStatus;
  warnings: string[];
  message?: string;
}

export interface InvalidRow {
  rowNumber: number;
  raw: Record<string, unknown>;
  error: string;
}

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

export interface Batch extends BatchSummary {
  results: HostResult[];
  invalidRows: InvalidRow[];
  warning?: string;
  softMaxRecords?: number;
}

export interface BatchProgress {
  id: string;
  status: BatchStatus;
  total: number;
  completed: number;
  counts: BatchCounts;
}

export interface DomainGroup {
  domain: string;
  total: number;
  counts: BatchCounts;
  results: HostResult[];
}

export interface AppConfig {
  appName: string;
  version: string;
  recordTypes: RecordType[];
  softMaxRecords: number;
  maxBatches: number;
  maxUploadBytes: number;
  dnsMaxRetries: number;
}

export interface ApiError {
  error: string;
  details?: Record<string, unknown>;
}
