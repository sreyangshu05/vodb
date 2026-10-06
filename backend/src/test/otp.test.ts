import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { hashOneTimeCode } from '../utils/otp.js';

test('one-time code hashes are keyed, deterministic, and not plain SHA-256', () => {
  const code = '123456';
  const firstHash = hashOneTimeCode(code, 'first-secret-with-at-least-32-characters');

  assert.equal(firstHash, hashOneTimeCode(code, 'first-secret-with-at-least-32-characters'));
  assert.notEqual(firstHash, hashOneTimeCode(code, 'second-secret-with-at-least-32-characters'));
  assert.notEqual(firstHash, createHash('sha256').update(code).digest('hex'));
  assert.match(firstHash, /^[a-f0-9]{64}$/);
});
