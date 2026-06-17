import type {
  AppConfig,
  Batch,
  BatchProgress,
  BatchSummary,
  DomainGroup,
  HostResult,
  RecordType,
} from './types';

// All requests use the relative /api base: in production nginx proxies it to
// the backend; in dev Vite proxies it to localhost:3001.
const API_BASE = '/api';

export class ApiRequestError extends Error {
  constructor(
    public readonly code: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(code);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, init);
  if (!response.ok) {
    let code = 'generic';
    let details: Record<string, unknown> | undefined;
    try {
      const body = await response.json();
      code = body.error ?? code;
      details = body.details;
    } catch {
      /* non-JSON error body */
    }
    throw new ApiRequestError(code, details);
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export function getConfig(): Promise<AppConfig> {
  return request<AppConfig>('/config');
}

export function listBatches(): Promise<BatchSummary[]> {
  return request<{ batches: BatchSummary[] }>('/batches').then((r) => r.batches);
}

export function getBatch(id: string): Promise<Batch> {
  return request<Batch>(`/batches/${id}`);
}

export function getBatchProgress(id: string): Promise<BatchProgress> {
  return request<BatchProgress>(`/batches/${id}/status`);
}

export function getBatchGroups(id: string): Promise<DomainGroup[]> {
  return request<{ groups: DomainGroup[] }>(`/batches/${id}/groups`).then(
    (r) => r.groups,
  );
}

export function createBatch(file: File, name: string): Promise<Batch> {
  const form = new FormData();
  form.append('file', file);
  if (name) form.append('name', name);
  return request<Batch>('/batches', { method: 'POST', body: form });
}

export function stopBatch(id: string): Promise<void> {
  return request<void>(`/batches/${id}/stop`, { method: 'POST' });
}

export function rerunBatch(id: string): Promise<Batch> {
  return request<Batch>(`/batches/${id}/rerun`, { method: 'POST' });
}

export interface SingleCheckInput {
  hostname: string;
  type: RecordType;
  value: string;
}

export function checkSingle(input: SingleCheckInput): Promise<HostResult> {
  return request<HostResult>('/check', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
}

export function deleteBatch(id: string): Promise<void> {
  return request<void>(`/batches/${id}`, { method: 'DELETE' });
}

export function templateUrl(format: 'xlsx' | 'csv'): string {
  return `${API_BASE}/template?format=${format}`;
}

export function exportUrl(id: string, format: 'xlsx' | 'csv'): string {
  return `${API_BASE}/batches/${id}/export?format=${format}`;
}
