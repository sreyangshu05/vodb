import assert from 'node:assert/strict';
import test from 'node:test';
import { assertProductionDatabaseTls } from '../config/databaseTls.js';

test('production database connections require explicit TLS', () => {
  assert.doesNotThrow(() => assertProductionDatabaseTls('postgres://user:pass@db.example/app?sslmode=require', false));
  assert.doesNotThrow(() => assertProductionDatabaseTls('postgres://user:pass@db.example/app?sslmode=verify-full', false));
  assert.doesNotThrow(() => assertProductionDatabaseTls(undefined, true));
  assert.throws(() => assertProductionDatabaseTls(undefined, false), /POSTGRES_SSL/);
  assert.throws(() => assertProductionDatabaseTls('postgres://user:pass@db.example/app?sslmode=disable', false), /require TLS/);
  assert.throws(() => assertProductionDatabaseTls('postgres://user:pass@db.example/app', false), /require TLS/);
});