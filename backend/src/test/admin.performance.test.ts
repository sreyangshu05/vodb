import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import app from '../server.js';
import { db } from '../lib/db.js';
import { signToken } from '../services/authService.js';

after(async () => {
  await db.end();
});

test('admin overview loads all dashboard counts with one database query', async () => {
  const mutableDb = db as unknown as {
    query: (sql: string) => Promise<{ rows: Array<Record<string, string>> }>;
    healthcheck: () => Promise<unknown>;
  };
  const originalQuery = mutableDb.query;
  const originalHealthcheck = mutableDb.healthcheck;
  const statements: string[] = [];
  mutableDb.query = async (sql) => {
    statements.push(sql);
    return {
      rows: [{
        blogs: '12',
        events: '8',
        pending_blogs: '2',
        pending_events: '3',
        open_inquiries: '4',
        active_subscribers: '15',
        users: '20',
      }],
    };
  };
  mutableDb.healthcheck = async () => ({ now: new Date().toISOString() });

  try {
    const token = await signToken({
      id: 'verification-admin',
      email: 'verification-admin@example.com',
      name: 'Verification Admin',
      role: 'admin',
    });
    const response = await request(app)
      .get('/api/v1/admin/overview')
      .set('Authorization', `Bearer ${token}`);

    assert.equal(response.status, 200);
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.deepEqual(response.body.content, { blogs: 12, events: 8, pendingReview: 5 });
    assert.deepEqual(response.body.submissions, { openInquiries: 4, activeSubscribers: 15 });
    assert.equal(response.body.users, 20);
    assert.equal(statements.length, 1);
    for (const alias of ['blogs', 'events', 'pending_blogs', 'pending_events', 'open_inquiries', 'active_subscribers', 'users']) {
      assert.match(statements[0] ?? '', new RegExp(`AS ${alias}\\b`, 'i'));
    }
  } finally {
    mutableDb.query = originalQuery as unknown as typeof mutableDb.query;
    mutableDb.healthcheck = originalHealthcheck;
  }
});

test('content review queue aggregates review history once instead of using a correlated lookup', async () => {
  const mutableDb = db as unknown as {
    query: (sql: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>;
  };
  const originalQuery = mutableDb.query;
  const statements: Array<{ sql: string; params?: unknown[] }> = [];
  mutableDb.query = async (sql, params) => {
    statements.push({ sql, params });
    return { rows: [] };
  };

  try {
    const token = await signToken({
      id: 'verification-admin',
      email: 'verification-admin@example.com',
      name: 'Verification Admin',
      role: 'admin',
    });
    const response = await request(app)
      .get('/api/v1/admin/content-review-queue?days=180')
      .set('Authorization', `Bearer ${token}`);

    assert.equal(response.status, 200);
    assert.equal(statements.length, 1);
    assert.deepEqual(statements[0]?.params, [180]);
    assert.match(statements[0]?.sql ?? '', /GROUP BY content\.resource_type, content\.id/);
    assert.match(statements[0]?.sql ?? '', /MAX\(audit\.occurred_at\) AS last_reviewed_at/);
    assert.doesNotMatch(statements[0]?.sql ?? '', /LATERAL/i);
  } finally {
    mutableDb.query = originalQuery as unknown as typeof mutableDb.query;
  }
});
