import assert from 'node:assert/strict';
import test from 'node:test';
import { createMaintenanceDatabaseConfig } from '../../scripts/database-connection.mjs';

test('remote URL connections enable certificate-verified TLS', () => {
  const config = createMaintenanceDatabaseConfig({
    NODE_ENV: 'production',
    DATABASE_URL: 'postgresql://user:pass@db.example.com/app',
  }, 1);

  assert.deepEqual(config.ssl, { rejectUnauthorized: true });
});

test('local URL connections keep TLS optional', () => {
  const config = createMaintenanceDatabaseConfig({
    DATABASE_URL: 'postgresql://user:pass@localhost/app',
  }, 1);

  assert.equal(config.ssl, undefined);
});

test('remote database URLs are blocked in local development until explicitly approved', () => {
  assert.throws(
    () => createMaintenanceDatabaseConfig({
      NODE_ENV: 'development',
      DATABASE_URL: 'postgresql://user:private-marker@remote.example.invalid/app',
    }, 1),
    /Remote database access is disabled outside production/,
  );

  assert.throws(
    () => createMaintenanceDatabaseConfig({
      NODE_ENV: 'test',
      DATABASE_URL: 'postgresql://user:private-marker@remote.example.invalid/app',
    }, 1),
    /Remote database access is disabled outside production/,
  );

  const approvedNonProductionConfig = createMaintenanceDatabaseConfig({
    NODE_ENV: 'development',
    ALLOW_REMOTE_DEVELOPMENT_SERVICES: 'true',
    DATABASE_URL: 'postgresql://user:private-marker@remote.example.invalid/app',
  }, 1);
  assert.deepEqual(approvedNonProductionConfig.ssl, { rejectUnauthorized: true });
});

test('remote host configuration requires TLS and verifies its certificate', () => {
  assert.throws(
    () => createMaintenanceDatabaseConfig({ NODE_ENV: 'production', POSTGRES_HOST: 'db.example.com' }, 1),
    /POSTGRES_SSL=true is required/,
  );

  const config = createMaintenanceDatabaseConfig({
    NODE_ENV: 'production',
    POSTGRES_HOST: 'db.example.com',
    POSTGRES_SSL: 'true',
  }, 1);
  assert.deepEqual(config.ssl, { rejectUnauthorized: true });
});

test('pooled URL is rejected unless a direct URL is provided', () => {
  assert.throws(
    () => createMaintenanceDatabaseConfig({
      NODE_ENV: 'production',
      DATABASE_URL: 'postgresql://user:pass@db-pooler.example.com/app',
    }, 1),
    /DIRECT_DATABASE_URL/,
  );
});
