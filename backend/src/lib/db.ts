import { Pool, types, type QueryResultRow } from 'pg';
import { env } from '../config/env.js';
import { metrics } from '../services/metricsService.js';
import { logger } from '../utils/logger.js';

// Preserve PostgreSQL microsecond precision for optimistic-concurrency timestamps.
// Converting timestamptz to JavaScript Date would round values to milliseconds and
// make an If-Match value from the API response unusable in the next write.
types.setTypeParser(1184, (value) => value);

const pool = new Pool({
  ...(env.DATABASE_URL
    ? {
        connectionString: env.DATABASE_URL,
        ...(env.NODE_ENV === 'production' ? { ssl: { rejectUnauthorized: true } } : {}),
      }
    : {
        host: env.POSTGRES_HOST,
        port: env.POSTGRES_PORT,
        database: env.POSTGRES_DB,
        user: env.POSTGRES_USER,
        password: env.POSTGRES_PASSWORD,
        ssl: env.POSTGRES_SSL ? { rejectUnauthorized: env.NODE_ENV === 'production' } : false,
      }),
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

type ApiErrorLog = { occurredAt: string; endpoint: string; errorMessage: string; userId?: string };
const pendingApiErrorLogs: ApiErrorLog[] = [];
let flushingApiErrorLogs = false;
let errorLogPersistenceWarningWritten = false;
const MAX_PENDING_API_ERROR_LOGS = 1000;

async function flushPendingApiErrorLogs() {
  if (flushingApiErrorLogs || pendingApiErrorLogs.length === 0) return;
  flushingApiErrorLogs = true;
  try {
    while (pendingApiErrorLogs.length > 0) {
      const entry = pendingApiErrorLogs[0];
      await pool.query(
        `INSERT INTO api_error_logs (occurred_at, endpoint, error_message, user_id)
         VALUES ($1, $2, $3, $4)`,
        [entry.occurredAt, entry.endpoint, entry.errorMessage, entry.userId ?? null],
      );
      pendingApiErrorLogs.shift();
      errorLogPersistenceWarningWritten = false;
    }
  } catch (error) {
    if (!errorLogPersistenceWarningWritten) {
      logger.warn('api_error_log_persist_deferred', {
        pendingCount: pendingApiErrorLogs.length,
        message: error instanceof Error ? error.message : 'Unable to persist API error logs.',
      });
      errorLogPersistenceWarningWritten = true;
    }
  } finally {
    flushingApiErrorLogs = false;
  }
}

function operationName(query: string) {
  return query.trim().replace(/\s+/g, ' ').slice(0, 42) || 'query';
}

async function runQuery<T extends QueryResultRow>(text: string, params?: unknown[]) {
  const startedAt = metrics.databaseQueryStarted(operationName(text));
  try {
    const result = await pool.query<T>(text, params);
    metrics.databaseQueryCompleted(startedAt);
    void flushPendingApiErrorLogs();
    return result;
  } catch (error) {
    metrics.databaseQueryCompleted(startedAt, true);
    throw error;
  }
}

export const db = {
  async query<T extends QueryResultRow>(text: string, params?: unknown[]) {
    return runQuery<T>(text, params);
  },
  async healthcheck() {
    const result = await runQuery<{
      now: string;
      has_rate_limit_buckets: boolean;
      has_google_auth_columns: boolean;
    }>(
      `SELECT NOW() AS now,
              to_regclass('public.rate_limit_buckets') IS NOT NULL AS has_rate_limit_buckets,
              (SELECT count(*) = 3
                 FROM information_schema.columns
                WHERE table_schema = 'public'
                  AND table_name = 'users'
                  AND column_name IN ('auth_provider', 'google_subject', 'email_verified'))
                AS has_google_auth_columns`,
    );
    if (!result.rows[0]?.has_rate_limit_buckets) {
      throw new Error('Database schema is missing rate_limit_buckets; apply migration 016_reliability_controls.sql.');
    }
    if (!result.rows[0]?.has_google_auth_columns) {
      throw new Error('Database schema is missing Google authentication fields; apply migrations 006_add_google_auth.sql and 014_require_verified_reader_email.sql.');
    }
    return result.rows[0];
  },
  async logApiError(input: { endpoint: string; errorMessage: string; userId?: string }) {
    if (pendingApiErrorLogs.length >= MAX_PENDING_API_ERROR_LOGS) {
      pendingApiErrorLogs.shift();
      logger.warn('api_error_log_queue_full', { droppedOldestEntry: true });
    }
    pendingApiErrorLogs.push({
      occurredAt: new Date().toISOString(),
      endpoint: input.endpoint.slice(0, 500),
      errorMessage: input.errorMessage.slice(0, 4000),
      userId: input.userId,
    });
    await flushPendingApiErrorLogs();
  },
  poolStats() {
    return {
      max: 20,
      total: pool.totalCount,
      idle: pool.idleCount,
      waiting: pool.waitingCount,
    };
  },
  async end() {
    await pool.end();
  },
};

export default pool;
