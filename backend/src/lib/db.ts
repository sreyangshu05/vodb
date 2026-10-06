import { Pool, types, type QueryResultRow } from 'pg';
import { env } from '../config/env.js';
import { metrics } from '../services/metricsService.js';

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

function operationName(query: string) {
  return query.trim().replace(/\s+/g, ' ').slice(0, 42) || 'query';
}

async function runQuery<T extends QueryResultRow>(text: string, params?: unknown[]) {
  const startedAt = metrics.databaseQueryStarted(operationName(text));
  try {
    const result = await pool.query<T>(text, params);
    metrics.databaseQueryCompleted(startedAt);
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
    const result = await runQuery<{ now: string }>('SELECT NOW() as now');
    return result.rows[0];
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
