import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import app from '../server.js';
import { db } from '../lib/db.js';
import { signToken } from '../services/authService.js';

after(async () => {
  await db.end();
});

test('admin user search binds user text and uses fixed, bounded pagination ordering', async () => {
  const mutableDb = db as unknown as {
    query: (sql: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>;
  };
  const originalQuery = mutableDb.query;
  const statements: Array<{ sql: string; params?: unknown[] }> = [];
  mutableDb.query = async (sql, params) => {
    statements.push({ sql, params });
    if (/count\(\*\)/i.test(sql)) return { rows: [{ count: '0' }] };
    return { rows: [] };
  };

  try {
    const token = await signToken({
      id: 'verification-admin',
      email: 'verification-admin@example.com',
      name: 'Verification Admin',
      role: 'admin',
    });
    const injectedLookingSearch = `বাংলা%' OR 1=1 --`;
    const response = await request(app)
      .get(`/api/v1/admin/users?search=${encodeURIComponent(injectedLookingSearch)}&status=member&limit=10&offset=20&sort=email`)
      .set('Authorization', `Bearer ${token}`);

    assert.equal(response.status, 200);
    assert.equal(response.body.limit, 10);
    assert.equal(response.body.offset, 20);
    assert.equal(statements.length, 2);
    assert.deepEqual(statements[0]?.params, ['member', `%${injectedLookingSearch}%`]);
    assert.match(statements[0]?.sql ?? '', /role = \$1.*name ILIKE \$2 OR email ILIKE \$2 OR role ILIKE \$2 OR auth_provider ILIKE \$2/s);
    assert.match(statements[1]?.sql ?? '', /ORDER BY created_at DESC, id ASC LIMIT \$3 OFFSET \$4/);
    assert.deepEqual(statements[1]?.params, ['member', `%${injectedLookingSearch}%`, 10, 20]);
    assert.doesNotMatch(statements[1]?.sql ?? '', /email\s+ASC/i);
  } finally {
    mutableDb.query = originalQuery as unknown as typeof mutableDb.query;
  }
});
