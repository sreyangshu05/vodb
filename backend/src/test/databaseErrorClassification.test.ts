import assert from 'node:assert/strict';
import test from 'node:test';
import { isDatabaseConfigurationError, isDatabaseUnavailable } from '../utils/databaseErrors.js';

test('classifies PostgreSQL connection and capacity SQLSTATE codes as unavailable', () => {
  for (const code of ['08006', '53300', '57P01', '57P02', '57P03']) {
    assert.equal(isDatabaseUnavailable(Object.assign(new Error('database request failed'), { code })), true);
  }
});

test('does not classify unrelated PostgreSQL query errors as database outages', () => {
  assert.equal(isDatabaseUnavailable(Object.assign(new Error('duplicate key'), { code: '23505' })), false);
});

test('classifies network failures but not database authentication failures as transient outages', () => {
  assert.equal(isDatabaseUnavailable(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })), true);
  assert.equal(isDatabaseUnavailable(Object.assign(new Error('password authentication failed'), { code: '28P01' })), false);
  assert.equal(isDatabaseConfigurationError(Object.assign(new Error('password authentication failed'), { code: '28P01' })), true);
});
