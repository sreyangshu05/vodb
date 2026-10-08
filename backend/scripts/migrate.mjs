import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import pg from 'pg';
import { createMaintenanceDatabaseConfig } from './database-connection.mjs';

const { Pool } = pg;
const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(backendRoot, '..');
const migrationsDirectory = path.resolve(repoRoot, 'database/migrations');
dotenv.config({ path: path.resolve(backendRoot, '.env') });

const onlyIndex = process.argv.indexOf('--only');
const onlyMigration = onlyIndex >= 0 ? process.argv[onlyIndex + 1] : undefined;
if (onlyIndex >= 0 && (!onlyMigration || !/^\d{3}_[a-z0-9_]+\.sql$/i.test(onlyMigration))) {
  throw new Error('Usage: npm run db:migrate -- --only <migration-file-name>');
}

const pool = new Pool(createMaintenanceDatabaseConfig(process.env, 1));

const migrationLock = 73821410826001;
let client;

try {
  client = await pool.connect();
  await client.query('SELECT pg_advisory_lock($1)', [migrationLock]);
  await client.query(`
    CREATE TABLE IF NOT EXISTS app_schema_migrations (
      name TEXT PRIMARY KEY,
      checksum CHAR(64) NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  const files = (await readdir(migrationsDirectory))
    .filter((name) => /^\d{3}_[a-z0-9_]+\.sql$/i.test(name))
    .sort();
  if (files.length === 0) throw new Error(`No SQL migrations found in ${migrationsDirectory}`);
  if (onlyMigration && !files.includes(onlyMigration)) {
    throw new Error(`Unknown migration: ${onlyMigration}`);
  }

  let applied = 0;
  let alreadyCurrent = 0;
  for (const name of files) {
    if (onlyMigration && name > onlyMigration) break;
    const sql = await readFile(path.join(migrationsDirectory, name), 'utf8');
    const checksum = createHash('sha256').update(sql).digest('hex');
    const existing = await client.query(
      'SELECT checksum FROM app_schema_migrations WHERE name = $1',
      [name],
    );

    if (existing.rows[0]) {
      if (existing.rows[0].checksum.trim() !== checksum) {
        throw new Error(`${name} was changed after being recorded. Create a new migration instead of editing an applied file.`);
      }
      process.stdout.write(`Already applied: ${name}\n`);
      alreadyCurrent += 1;
      continue;
    }

    if (onlyMigration && name !== onlyMigration) {
      throw new Error(`Cannot apply only ${onlyMigration}; prerequisite ${name} is not recorded as applied.`);
    }

    process.stdout.write(`Applying: ${name}\n`);
    await client.query(sql);
    await client.query(
      'INSERT INTO app_schema_migrations (name, checksum) VALUES ($1, $2)',
      [name, checksum],
    );
    applied += 1;
  }

  process.stdout.write(`Migration run complete: ${applied} applied, ${alreadyCurrent} already current.\n`);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Migration failed: ${message}\n`);
  process.exitCode = 1;
} finally {
  if (client) {
    try { await client.query('SELECT pg_advisory_unlock($1)', [migrationLock]); } catch { /* the connection may already be closed */ }
    client.release();
  }
  await pool.end();
}
