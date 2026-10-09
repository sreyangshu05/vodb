import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import app from '../server.js';
import { db } from '../lib/db.js';
import { signToken } from '../services/authService.js';

after(async () => {
  await db.end();
});

test('saved pages use bounded keyset pagination with a stable composite cursor', async () => {
  const mutableDb = db as unknown as {
    query: (sql: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, string>> }>;
  };
  const originalQuery = mutableDb.query;
  const statements: Array<{ sql: string; params?: unknown[] }> = [];
  const timestamp = '2026-10-09 00:00:00.123456+00';
  mutableDb.query = async (sql, params) => {
    statements.push({ sql, params });
    return {
      rows: statements.length === 1
        ? [
            { path: '/first', title: 'First', created_at: timestamp },
            { path: '/second', title: 'Second', created_at: timestamp },
          ]
        : [{ path: '/third', title: 'Third', created_at: '2026-10-08 00:00:00+00' }],
    };
  };

  try {
    const token = await signToken({
      id: 'verification-member',
      email: 'verification-member@example.com',
      name: 'Verification Member',
      role: 'member',
    });
    const firstPage = await request(app)
      .get('/api/v1/auth/me/saved-pages?limit=1')
      .set('Authorization', `Bearer ${token}`);

    assert.equal(firstPage.status, 200);
    assert.deepEqual(firstPage.body.items.map((item: { path: string }) => item.path), ['/first']);
    assert.equal(firstPage.body.hasMore, true);
    assert.ok(typeof firstPage.body.nextCursor === 'string');
    assert.deepEqual(statements[0]?.params, ['verification-member', null, null, 2]);
    assert.match(statements[0]?.sql ?? '', /ORDER BY created_at DESC, page_path DESC\s+LIMIT \$4/);
    assert.match(statements[0]?.sql ?? '', /\(created_at, page_path\) < \(\$2::timestamptz, \$3::varchar\)/);

    const secondPage = await request(app)
      .get(`/api/v1/auth/me/saved-pages?limit=1&cursor=${encodeURIComponent(firstPage.body.nextCursor)}`)
      .set('Authorization', `Bearer ${token}`);
    assert.equal(secondPage.status, 200);
    assert.deepEqual(secondPage.body.items.map((item: { path: string }) => item.path), ['/third']);
    assert.equal(secondPage.body.hasMore, false);
    assert.equal(secondPage.body.nextCursor, null);
    assert.deepEqual(statements[1]?.params, ['verification-member', timestamp, '/first', 2]);
  } finally {
    mutableDb.query = originalQuery as unknown as typeof mutableDb.query;
  }
});

test('saved-page pagination rejects malformed cursors and excessive limits', async () => {
  const token = await signToken({
    id: 'verification-member',
    email: 'verification-member@example.com',
    name: 'Verification Member',
    role: 'member',
  });
  const responses = await Promise.all([
    request(app).get('/api/v1/auth/me/saved-pages?cursor=not-json').set('Authorization', `Bearer ${token}`),
    request(app).get('/api/v1/auth/me/saved-pages?limit=101').set('Authorization', `Bearer ${token}`),
  ]);
  assert.deepEqual(responses.map((response) => response.status), [422, 422]);
  assert.deepEqual(responses.map((response) => response.body.error), ['invalid_saved_page_cursor', 'invalid_saved_page_pagination']);
});
