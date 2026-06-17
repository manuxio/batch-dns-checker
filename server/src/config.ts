import path from 'node:path';

/**
 * Centralized runtime configuration, sourced from environment variables with
 * sensible defaults so the service runs out-of-the-box in development.
 */
export const config = {
  port: Number(process.env.PORT ?? 3001),
  dataDir: process.env.DATA_DIR ?? path.resolve(process.cwd(), 'data'),
  /** Per-query DNS timeout in milliseconds. */
  dnsTimeoutMs: Number(process.env.DNS_TIMEOUT_MS ?? 5000),
  /** Retries per DNS query before giving up. */
  dnsTries: Number(process.env.DNS_TRIES ?? 2),
  /** How many hostnames are checked concurrently within a batch. */
  hostConcurrency: Number(process.env.DNS_HOST_CONCURRENCY ?? 8),
  /** Max retries per DNS query on transient resolution errors. */
  dnsMaxRetries: Number(process.env.DNS_MAX_RETRIES ?? 10),
  /** Backoff (ms) between retries; the last value repeats for further retries. */
  dnsBackoffMs: parseBackoff(process.env.DNS_BACKOFF_MS, [100, 500, 1000, 2000]),
  /**
   * Force using the local/recursive resolver instead of iterating from root.
   * Useful where outbound DNS is only allowed to a fixed resolver.
   */
  dnsForceLocalResolver: parseBool(process.env.DNS_FORCE_LOCAL_RESOLVER, false),
  /**
   * Resolver IPs used for the fallback (and forced-local) path. Empty = use the
   * system/container default resolver.
   */
  dnsFallbackServers: parseList(process.env.DNS_FALLBACK_SERVERS),
  /** Soft cap on records per batch: exceeding it warns but does not block. */
  softMaxRecords: Number(process.env.SOFT_MAX_RECORDS ?? 150),
  /** Maximum accepted upload size in bytes. */
  maxUploadBytes: Number(process.env.MAX_UPLOAD_BYTES ?? 10 * 1024 * 1024),
  /** How many past batches are retained for consultation. */
  maxBatches: Number(process.env.MAX_BATCHES ?? 10),
} as const;

function parseBackoff(value: string | undefined, fallback: number[]): number[] {
  if (!value) return fallback;
  const parsed = value
    .split(',')
    .map((v) => Number(v.trim()))
    .filter((v) => Number.isFinite(v) && v >= 0);
  return parsed.length > 0 ? parsed : fallback;
}

function parseBool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

function parseList(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
}

export type AppConfig = typeof config;
