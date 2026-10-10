import assert from 'node:assert/strict';
import test from 'node:test';
import { safeErrorCodeFromBody } from '../middleware/apiErrorLog.js';

test('persisted API error labels accept only bounded machine-readable codes', () => {
  assert.equal(safeErrorCodeFromBody({ error: 'invalid_request', message: 'Bad input' }), 'invalid_request');
  assert.equal(safeErrorCodeFromBody({ error: 'secret=do-not-store' }), undefined);
  assert.equal(safeErrorCodeFromBody({ message: 'private email alice@example.com' }), undefined);
  assert.equal(safeErrorCodeFromBody('not json'), undefined);
});
