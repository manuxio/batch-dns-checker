import { config } from '../config';

/**
 * Transient errors worth retrying with backoff. Network-unreachable / host-
 * unreachable / refused are NOT retried: they fail fast so the caller can move
 * on to the next IP or nameserver (e.g. an IPv6 address on an IPv4-only host).
 */
const RETRYABLE_CODES = new Set([
  'ETIMEOUT',
  'ETIMEDOUT',
  'ECONNRESET',
  'EAI_AGAIN',
]);

export function isRetryableCode(code: string | undefined): boolean {
  return !!code && RETRYABLE_CODES.has(code);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function backoffForRetry(retry: number): number {
  const table = config.dnsBackoffMs;
  return table[Math.min(retry - 1, table.length - 1)];
}

/**
 * Runs an async operation, retrying transient failures up to `maxRetries` times
 * with the configured backoff (default 100ms, 500ms, 1s, 2s, then 2s).
 */
export async function withRetry<T>(
  operation: () => Promise<T>,
  maxRetries: number = config.dnsMaxRetries,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      return await operation();
    } catch (err) {
      lastError = err;
      const code = (err as NodeJS.ErrnoException).code;
      if (!isRetryableCode(code) || attempt === maxRetries) throw err;
      await sleep(backoffForRetry(attempt + 1));
    }
  }
  throw lastError;
}
