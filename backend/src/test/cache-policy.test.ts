import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import app from '../server.js';
import { db } from '../lib/db.js';

after(async () => {
  await db.end();
});

test('published static media opts into a short public cache while missing private-media credentials stay no-store', async () => {
  const mutableDb = db as unknown as {
    query: (sql: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>;
  };
  const originalQuery = mutableDb.query;
  mutableDb.query = async () => ({
    rows: [{
      id: 'b5ec8f67-9f6e-4f5d-9d73-6387f7db9273',
      created_at: '2026-10-09T00:00:00.000Z',
      image_data: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      mime_type: 'image/png',
      byte_size: 8,
    }],
  });

  try {
    const publicImage = await request(app)
      .get('/api/v1/media/source')
      .query({ path: '/cache-policy/image.png' });
    assert.equal(publicImage.status, 200);
    assert.equal(publicImage.headers['cache-control'], 'public, max-age=300, stale-while-revalidate=60');
    assert.ok(publicImage.headers.etag);

    const privateMediaWithoutToken = await request(app).get('/api/v1/media/stream');
    assert.equal(privateMediaWithoutToken.status, 401);
    assert.equal(privateMediaWithoutToken.headers['cache-control'], 'no-store');
  } finally {
    mutableDb.query = originalQuery as unknown as typeof mutableDb.query;
  }
});
