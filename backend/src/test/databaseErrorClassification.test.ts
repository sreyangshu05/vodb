import assert from 'node:assert/strict';
import test from 'node:test';
import { isDatabaseUnavailable } from '../middleware/errorHandler.js';

test('classifies PostgreSQL connection and capacity SQLSTATE codes as unavailable', () => {
  for (const code of ['08006', '53300', '57P01', '57P02', '57P03']) {
    assert.equal(isDatabaseUnavailable(Object.assign(new Error('database request failed'), { code })), true);
  }
});

test('does not classify unrelated PostgreSQL query errors as database outages', () => {
  assert.equal(isDatabaseUnavailable(Object.assign(new Error('duplicate key'), { code: '23505' })), false);
});
