import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import app from '../server.js';
import { db } from '../lib/db.js';
import { waitForAuditWrites } from '../services/auditService.js';
import { env } from '../config/env.js';
import { createPasswordReset, signToken } from '../services/authService.js';
import { createNewsletterSubscription } from '../services/submissionService.js';

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

test('contact submission retries with the same idempotency key create one inquiry', {
  skip: integrationEnabled ? false : 'set BACKEND_TEST_DATABASE_MODE=available to run database integration tests',
}, async () => {
  const idempotencyKey = randomUUID();
  const payload = {
    name: 'Idempotency Verification',
    email: `idempotency-${Date.now()}@example.com`,
    subject: 'Retry check',
    message: 'This request must only create one contact inquiry.',
  };

  try {
    const responses = await Promise.all([
      request(app).post('/api/v1/contact').set('Idempotency-Key', idempotencyKey).send(payload),
      request(app).post('/api/v1/contact').set('Idempotency-Key', idempotencyKey).send(payload),
    ]);
    assert.deepEqual(responses.map((response) => response.status).sort(), [200, 201]);
    assert.equal(responses[0]?.body.id, responses[1]?.body.id);

    const count = await db.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM contact_inquiries WHERE idempotency_key = $1',
      [idempotencyKey],
    );
    assert.equal(count.rows[0]?.count, '1');
  } finally {
    await db.query('DELETE FROM contact_inquiries WHERE idempotency_key = $1', [idempotencyKey]);
  }
});

test('a revoked account token stops authenticating while a newly signed token remains valid', {
  skip: integrationEnabled ? false : 'set BACKEND_TEST_DATABASE_MODE=available to run database integration tests',
}, async () => {
  const email = `token-version-${Date.now()}@example.com`;
  let userId: string | undefined;

  try {
    const created = await db.query<{ id: string; name: string; email: string; role: 'member' }>(
      `INSERT INTO users (name, email, password_hash, email_verified)
       VALUES ('Token Version Test', $1, 'test-hash', TRUE)
       RETURNING id, name, email, role`,
      [email],
    );
    const user = created.rows[0]!;
    userId = user.id;
    const oldToken = await signToken(user);

    await db.query('UPDATE users SET token_version = token_version + 1 WHERE id = $1', [user.id]);
    const revoked = await request(app)
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${oldToken}`);
    assert.equal(revoked.status, 401);

    const currentToken = await signToken(user);
    const current = await request(app)
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${currentToken}`);
    assert.equal(current.status, 200);
  } finally {
    if (userId) await db.query('DELETE FROM users WHERE id = $1', [userId]);
  }
});

test('password reset refreshes the active matching session while revoking its old token', {
  skip: integrationEnabled ? false : 'set BACKEND_TEST_DATABASE_MODE=available to run database integration tests',
}, async () => {
  const email = `password-reset-session-${Date.now()}@example.com`;
  let userId: string | undefined;

  try {
    const created = await db.query<{ id: string; name: string; email: string; role: 'member' }>(
      `INSERT INTO users (name, email, password_hash, email_verified)
       VALUES ('Password Reset Session Test', $1, 'test-hash', TRUE)
       RETURNING id, name, email, role`,
      [email],
    );
    const user = created.rows[0]!;
    userId = user.id;
    const oldToken = await signToken(user);
    const reset = await createPasswordReset(email);
    assert.ok(reset);

    const response = await request(app)
      .post('/api/v1/auth/reset-password')
      .set('Authorization', `Bearer ${oldToken}`)
      .send({ email, otp: reset.code, password: 'new-password-123' });

    assert.equal(response.status, 200);
    assert.equal(response.body.user.id, user.id);
    assert.equal(typeof response.body.token, 'string');

    const oldSession = await request(app)
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${oldToken}`);
    const refreshedSession = await request(app)
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${response.body.token as string}`);
    assert.equal(oldSession.status, 401);
    assert.equal(refreshedSession.status, 200);
  } finally {
    if (userId) await db.query('DELETE FROM users WHERE id = $1', [userId]);
  }
});

test('concurrent newsletter submissions do not rotate a valid pending confirmation token', {
  skip: integrationEnabled ? false : 'set BACKEND_TEST_DATABASE_MODE=available to run database integration tests',
}, async () => {
  const email = `newsletter-race-${Date.now()}@example.com`;

  try {
    const results = await Promise.allSettled([
      createNewsletterSubscription({ email, source: 'integration-test' }),
      createNewsletterSubscription({ email, source: 'integration-test' }),
    ]);
    const successful = results.filter((result) => result.status === 'fulfilled');
    assert.equal(successful.length, 1);
    if (successful[0]?.status === 'fulfilled') {
      assert.equal(typeof successful[0].value.confirmationToken, 'string');
    }

    const stored = await db.query<{ status: string; confirmation_token_hash: string | null }>(
      'SELECT status, confirmation_token_hash FROM newsletter_subscriptions WHERE lower(email) = lower($1)',
      [email],
    );
    assert.equal(stored.rows[0]?.status, 'pending');
    assert.equal(typeof stored.rows[0]?.confirmation_token_hash, 'string');
  } finally {
    await db.query('DELETE FROM newsletter_subscriptions WHERE lower(email) = lower($1)', [email]);
  }
});
