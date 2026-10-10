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

test('recognizes all configured database network failure codes', () => {
  for (const code of ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE', 'EAI_AGAIN', 'ENOTFOUND']) {
    assert.equal(isDatabaseUnavailable(Object.assign(new Error('network request failed'), { code })), true, code);
  }
});

test('uses known connection message fallbacks only when no structured code is available', () => {
  assert.equal(isDatabaseUnavailable(new Error('could not connect to server: connection refused')), true);
  assert.equal(isDatabaseUnavailable(new Error('connection terminated unexpectedly')), true);
  assert.equal(isDatabaseUnavailable(new Error('timeout exceeded when trying to connect')), true);
  assert.equal(isDatabaseUnavailable(Object.assign(new Error('could not connect to server'), { code: '23505' })), false);
  assert.equal(isDatabaseUnavailable(new Error('syntax error in query')), false);
  assert.equal(isDatabaseUnavailable('ECONNREFUSED'), false);
  assert.equal(isDatabaseUnavailable({ code: 503 }), false);
});

test('classifies only PostgreSQL authentication and missing-database SQLSTATEs as configuration errors', () => {
  for (const code of ['28P01', '3D000']) {
    assert.equal(isDatabaseConfigurationError(Object.assign(new Error('configuration failure'), { code })), true);
  }
  for (const code of ['08006', '23505', '53300']) {
    assert.equal(isDatabaseConfigurationError(Object.assign(new Error('other failure'), { code })), false);
  }
  assert.equal(isDatabaseConfigurationError(new Error('password authentication failed')), false);
  assert.equal(isDatabaseConfigurationError(null), false);
});
