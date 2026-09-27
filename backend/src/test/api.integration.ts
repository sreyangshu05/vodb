import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import app from '../server.js';
import { db } from '../lib/db.js';
import { waitForAuditWrites } from '../services/auditService.js';
import { env } from '../config/env.js';

const integrationEnabled = process.env.BACKEND_TEST_DATABASE_MODE === 'available';

after(async () => {
  await waitForAuditWrites();
  await db.end();
});

test('concurrent blog updates use optimistic concurrency and return one 409 conflict', {
  skip: integrationEnabled ? false : 'set BACKEND_TEST_DATABASE_MODE=available to run database integration tests',
}, async () => {
  const adminLogin = await request(app)
    .post('/api/v1/admin/login')
    .send({ email: env.ADMIN_EMAIL, password: env.ADMIN_PASSWORD });
  assert.equal(adminLogin.status, 200);
  const token = adminLogin.body.token as string;
  const slug = `verification-concurrency-${Date.now()}`;
  let blogId: string | undefined;

  try {
    const created = await request(app)
      .post('/api/v1/admin/blogs')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'Concurrency Verification', slug, content: 'Temporary integration fixture.', published: false });
    assert.equal(created.status, 201);
    blogId = created.body.id as string;
    const version = created.body.updated_at as string;

    const [first, second] = await Promise.all([
      request(app)
        .patch(`/api/v1/admin/blogs/${blogId}`)
        .set('Authorization', `Bearer ${token}`)
        .set('If-Match', `"${version}"`)
        .send({ title: 'Concurrency Winner A' }),
      request(app)
        .patch(`/api/v1/admin/blogs/${blogId}`)
        .set('Authorization', `Bearer ${token}`)
        .set('If-Match', `"${version}"`)
        .send({ title: 'Concurrency Winner B' }),
    ]);

    assert.deepEqual([first.status, second.status].sort((a, b) => a - b), [200, 409]);
    const conflict = first.status === 409 ? first : second;
    assert.equal(conflict.body.error, 'concurrent_update');
  } finally {
    if (blogId) {
      await db.query('DELETE FROM blog_posts WHERE id = $1', [blogId]);
    } else {
      await db.query('DELETE FROM blog_posts WHERE slug = $1', [slug]);
    }
  }
});
