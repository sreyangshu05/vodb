import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import pg from 'pg';

const { Pool } = pg;
const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(backendRoot, '..');
const migrationsDirectory = path.resolve(repoRoot, 'database/migrations');
dotenv.config({ path: path.resolve(backendRoot, '.env') });

const connectionString = process.env.DIRECT_DATABASE_URL || process.env.DATABASE_URL;
if (connectionString) {
  const hostname = new URL(connectionString).hostname;
  if (!process.env.DIRECT_DATABASE_URL && hostname.includes('-pooler')) {
    throw new Error("Set DIRECT_DATABASE_URL to Neon's direct connection string before running migrations.");
  }
}

const pool = new Pool(connectionString
  ? { connectionString, max: 1, connectionTimeoutMillis: 10000 }
  : {
      host: process.env.POSTGRES_HOST || '127.0.0.1',
      port: Number(process.env.POSTGRES_PORT || 5433),
      database: process.env.POSTGRES_DB || 'appdb',
      user: process.env.POSTGRES_USER || 'postgres',
      password: process.env.POSTGRES_PASSWORD,
      ssl: process.env.POSTGRES_SSL === 'true' ? { rejectUnauthorized: false } : false,
      max: 1,
      connectionTimeoutMillis: 10000,
    });

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

  let applied = 0;
  for (const name of files) {
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
      continue;
    }

    process.stdout.write(`Applying: ${name}\n`);
    await client.query(sql);
    await client.query(
      'INSERT INTO app_schema_migrations (name, checksum) VALUES ($1, $2)',
      [name, checksum],
    );
    applied += 1;
  }

  process.stdout.write(`Migration run complete: ${applied} applied, ${files.length - applied} already current.\n`);
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
