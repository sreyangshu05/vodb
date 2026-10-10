import dotenv from 'dotenv';
import pg from 'pg';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMaintenanceDatabaseConfig } from './database-connection.mjs';

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
dotenv.config({ path: path.resolve(backendRoot, '.env') });

const apply = process.argv.includes('--apply');
const batchArg = process.argv.find((arg) => arg.startsWith('--batch-size='));
const batchSize = batchArg ? Number(batchArg.slice('--batch-size='.length)) : 1000;
if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 10000) {
  throw new Error('--batch-size must be an integer from 1 to 10000.');
}

const { Pool } = pg;
const pool = new Pool(createMaintenanceDatabaseConfig(process.env, 1));
const policies = [
  {
    name: 'expired password reset codes',
    countSql: 'SELECT count(*)::bigint AS count FROM password_reset_otps WHERE expires_at <= now()',
    deleteSql: `WITH expired AS (
      SELECT id FROM password_reset_otps
      WHERE expires_at <= now()
      ORDER BY expires_at, id
      LIMIT $1
      FOR UPDATE SKIP LOCKED
    )
    DELETE FROM password_reset_otps target USING expired WHERE target.id = expired.id`,
  },
  {
    name: 'expired email verification codes',
    countSql: 'SELECT count(*)::bigint AS count FROM reader_email_verification_otps WHERE expires_at <= now()',
    deleteSql: `WITH expired AS (
      SELECT user_id FROM reader_email_verification_otps
      WHERE expires_at <= now()
      ORDER BY expires_at, user_id
      LIMIT $1
      FOR UPDATE SKIP LOCKED
    )
    DELETE FROM reader_email_verification_otps target USING expired WHERE target.user_id = expired.user_id`,
  },
  {
    name: 'audit_events (excluding legal holds)',
    countSql: "SELECT count(*)::bigint AS count FROM audit_events WHERE occurred_at < now() - interval '7 years' AND legal_hold = FALSE",
    deleteSql: `WITH expired AS (
      SELECT id FROM audit_events
      WHERE occurred_at < now() - interval '7 years' AND legal_hold = FALSE
      ORDER BY occurred_at, id
      LIMIT $1
      FOR UPDATE SKIP LOCKED
    )
    DELETE FROM audit_events target USING expired WHERE target.id = expired.id`,
  },
  {
    name: 'protected_media_access_log',
    countSql: "SELECT count(*)::bigint AS count FROM protected_media_access_log WHERE created_at < now() - interval '90 days'",
    deleteSql: `WITH expired AS (
      SELECT id FROM protected_media_access_log
      WHERE created_at < now() - interval '90 days'
      ORDER BY created_at, id
      LIMIT $1
      FOR UPDATE SKIP LOCKED
    )
    DELETE FROM protected_media_access_log target USING expired WHERE target.id = expired.id`,
  },
  {
    name: 'api_error_logs',
    countSql: "SELECT count(*)::bigint AS count FROM api_error_logs WHERE occurred_at < now() - interval '30 days'",
    deleteSql: `WITH expired AS (
      SELECT id FROM api_error_logs
      WHERE occurred_at < now() - interval '30 days'
      ORDER BY occurred_at, id
      LIMIT $1
      FOR UPDATE SKIP LOCKED
    )
    DELETE FROM api_error_logs target USING expired WHERE target.id = expired.id`,
  },
  {
    name: 'newsletter_delivery_webhook_events',
    countSql: "SELECT count(*)::bigint AS count FROM newsletter_delivery_webhook_events WHERE received_at < now() - interval '90 days'",
    deleteSql: `WITH expired AS (
      SELECT event_id FROM newsletter_delivery_webhook_events
      WHERE received_at < now() - interval '90 days'
      ORDER BY received_at, event_id
      LIMIT $1
      FOR UPDATE SKIP LOCKED
    )
    DELETE FROM newsletter_delivery_webhook_events target USING expired WHERE target.event_id = expired.event_id`,
  },
];

try {
  for (const policy of policies) {
    if (!apply) {
      const result = await pool.query(policy.countSql);
      process.stdout.write(`Would delete ${result.rows[0].count} expired rows from ${policy.name}.\n`);
      continue;
    }

    let deleted = 0;
    while (true) {
      const result = await pool.query(policy.deleteSql, [batchSize]);
      deleted += result.rowCount ?? 0;
      if ((result.rowCount ?? 0) < batchSize) break;
    }
    process.stdout.write(`Deleted ${deleted} expired rows from ${policy.name}.\n`);
  }

  if (!apply) process.stdout.write('Dry run only. Pass --apply to delete expired rows.\n');
} finally {
  await pool.end();
}
