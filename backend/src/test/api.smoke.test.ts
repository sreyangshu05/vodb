import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import type { Request } from 'express';
import request from 'supertest';
import app from '../server.js';
import { db } from '../lib/db.js';
import { waitForAuditWrites } from '../services/auditService.js';
import { signToken } from '../services/authService.js';
import { metrics } from '../services/metricsService.js';
import { env } from '../config/env.js';

after(async () => {
  await waitForAuditWrites();
  await db.end();
});

test('GET /api/v1/health reports process liveness when the database is unavailable', async () => {
  const res = await request(app).get('/api/v1/health');
  assert.equal(res.status, 200);
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.equal(res.body.ok, true);
  assert.equal(res.body.status, 'alive');
  assert.ok(typeof res.headers['x-request-id'] === 'string');
});

test('observability snapshots are not cacheable', async () => {
  const response = await request(app).get('/api/v1/observability/snapshot');
  assert.equal(response.status, 200);
  assert.equal(response.headers['cache-control'], 'no-store');
});

test('GET /api/v1/readiness reports database unavailability', async () => {
  const res = await request(app).get('/api/v1/readiness');
  assert.equal(res.status, 503);
  assert.deepEqual(res.body, {
    ok: false,
    service: 'voice-of-digi-bengal-backend',
    database: 'unavailable',
  });
});

test('public and admin list pagination rejects malformed values as client errors', async () => {
  const publicResponses = await Promise.all([
    request(app).get('/api/v1/blogs?limit=not-a-number'),
    request(app).get('/api/v1/events?offset=-1'),
  ]);
  assert.equal(publicResponses[0]?.status, 422);
  assert.equal(publicResponses[0]?.body.error, 'invalid_pagination');
  assert.equal(publicResponses[1]?.status, 422);
  assert.equal(publicResponses[1]?.body.error, 'invalid_pagination');

  const adminToken = await signToken({
    id: 'verification-admin',
    email: 'verification-admin@example.com',
    name: 'Verification Admin',
    role: 'admin',
  });
  const adminResponses = await Promise.all([
    request(app).get('/api/v1/admin/blogs?limit=not-a-number').set('Authorization', `Bearer ${adminToken}`),
    request(app).get('/api/v1/admin/events?limit=0').set('Authorization', `Bearer ${adminToken}`),
  ]);
  for (const response of adminResponses) {
    assert.equal(response.status, 422);
    assert.equal(response.body.error, 'invalid_request');
    assert.equal(response.body.message, 'Request validation failed.');
    assert.ok(Array.isArray(response.body.details.issues));
    assert.equal(JSON.stringify(response.body).includes('not-a-number'), false);
  }
});

test('GET /api/v1/health replaces invalid client request IDs', async () => {
  const res = await request(app)
    .get('/api/v1/health')
    .set('x-request-id', 'untrusted-client-value');

  assert.equal(res.status, 200);
  assert.notEqual(res.headers['x-request-id'], 'untrusted-client-value');
  assert.match(res.headers['x-request-id'], /^[0-9a-f-]{36}$/i);
});

test('unknown routes return a stable not-found response', async () => {
  const res = await request(app).get('/api/v1/route-that-does-not-exist');

  assert.equal(res.status, 404);
  assert.equal(res.body.error, 'not_found');
});

test('malformed and oversized JSON request bodies return client errors', async () => {
  const malformed = await request(app)
    .post('/api/v1/auth/google')
    .set('Content-Type', 'application/json')
    .send('{');
  assert.equal(malformed.status, 400);
  assert.equal(malformed.body.error, 'invalid_json');

  const oversized = await request(app)
    .post('/api/v1/auth/google')
    .set('Content-Type', 'application/json')
    .send(`{"payload":"${'x'.repeat(1024 * 1024)}"}`);
  assert.equal(oversized.status, 413);
  assert.equal(oversized.body.error, 'payload_too_large');
});

test('media upload checks authentication before parsing its request body', async (context) => {
  context.mock.method(db, 'logApiError', async () => undefined);
  const response = await request(app)
    .post('/api/v1/media/upload')
    .set('Content-Type', 'application/json')
    .send('{');

  assert.equal(response.status, 401);
  assert.equal(response.body.error, 'unauthorized');
});

test('media upload rejects file signatures that do not match the declared image format', async () => {
  const token = await signToken({
    id: 'verification-admin',
    email: 'verification-admin@example.com',
    name: 'Verification Admin',
    role: 'admin',
  });
  const response = await request(app)
    .post('/api/v1/media/upload')
    .set('Authorization', `Bearer ${token}`)
    .send({
      data: `data:image/png;base64,${Buffer.from('not a png').toString('base64')}`,
      mimeType: 'image/png',
      fileName: '../../unsafe.png',
    });

  assert.equal(response.status, 422);
  assert.equal(response.body.error, 'invalid_image');
});

test('authenticated non-admin users cannot access admin routes', async () => {
  const token = await signToken({
    id: 'verification-member',
    email: 'verification-member@example.com',
    name: 'Verification Member',
    role: 'member',
  });
  const res = await request(app)
    .get('/api/v1/admin/me')
    .set('Authorization', `Bearer ${token}`);

  assert.equal(res.status, 403);
  assert.equal(res.body.error, 'forbidden');
});

test('media upload rejects truncated images during decoding before database access', async () => {
  const anonymous = await request(app)
    .post('/api/v1/media/upload')
    .send({ data: 'data:image/png;base64,iVBORw0KGgo=', mimeType: 'image/png' });
  assert.equal(anonymous.status, 401);

  const token = await signToken({
    id: 'verification-admin',
    email: 'verification-admin@example.com',
    name: 'Verification Admin',
    role: 'admin',
  });
  const response = await request(app)
    .post('/api/v1/media/upload')
    .set('Authorization', `Bearer ${token}`)
    .send({ data: 'data:image/png;base64,iVBORw0KGgo=', mimeType: 'image/png', fileName: '../unsafe.png' });

  assert.equal(response.status, 422);
  assert.equal(response.body.error, 'invalid_image');
});

test('reader profile, preference, and saved-page APIs require authentication', async () => {
  const responses = await Promise.all([
    request(app).get('/api/v1/auth/me'),
    request(app).patch('/api/v1/auth/me').send({ name: 'Updated Reader' }),
    request(app).patch('/api/v1/auth/me/preferences').send({ topics: ['history'] }),
    request(app).get('/api/v1/auth/me/saved-pages'),
    request(app).post('/api/v1/auth/me/saved-pages').send({ path: '/history', title: 'History' }),
    request(app).delete('/api/v1/auth/me/saved-pages').send({ path: '/history' }),
  ]);

  for (const response of responses) {
    assert.equal(response.status, 401);
    assert.equal(response.body.error, 'unauthorized');
  }
});

test('admin audience APIs require authentication', async () => {
  const responses = await Promise.all([
    request(app).get('/api/v1/admin/inquiries?limit=25&offset=0'),
    request(app).get('/api/v1/admin/subscribers?limit=25&offset=0'),
    request(app).get('/api/v1/admin/users?limit=25&offset=0'),
  ]);

  for (const response of responses) {
    assert.equal(response.status, 401);
    assert.equal(response.body.error, 'unauthorized');
  }
});

test('newsletter delivery webhook rejects signatures over re-serialized JSON instead of raw bytes', async () => {
  const rawBody = '{ "eventId":"smoke-event", "occurredAt":"2026-10-09T00:00:00.000Z", "event":"delivered", "email":"reader@example.com" }';
  const signature = env.NEWSLETTER_WEBHOOK_SECRET
    ? createHmac('sha256', env.NEWSLETTER_WEBHOOK_SECRET).update(JSON.stringify(JSON.parse(rawBody))).digest('hex')
    : '0'.repeat(64);
  const response = await request(app)
    .post('/api/v1/newsletter/webhooks/delivery')
    .set('Content-Type', 'application/json')
    .set('X-Newsletter-Signature', signature)
    .send(rawBody);

  assert.equal(response.status, env.NEWSLETTER_WEBHOOK_SECRET ? 401 : 503);
  assert.equal(response.body.error, env.NEWSLETTER_WEBHOOK_SECRET ? 'invalid_webhook_signature' : 'newsletter_webhook_unavailable');
});

test('saved-page API rejects external and backslash-normalized paths', async () => {
  const token = await signToken({
    id: 'verification-member',
    email: 'verification-member@example.com',
    name: 'Verification Member',
    role: 'member',
  });
  for (const path of ['//outside.example', '/\\\\outside.example']) {
    const response = await request(app)
      .post('/api/v1/auth/me/saved-pages')
      .set('Authorization', `Bearer ${token}`)
      .send({ path, title: 'External path' });
    assert.equal(response.status, 422);
    assert.equal(response.body.error, 'invalid_saved_page');
  }
});

test('account deletion requires confirmation and cannot delete admin identities', async () => {
  const memberToken = await signToken({
    id: 'verification-member',
    email: 'verification-member@example.com',
    name: 'Verification Member',
    role: 'member',
  });
  const missingConfirmation = await request(app)
    .delete('/api/v1/auth/me')
    .set('Authorization', `Bearer ${memberToken}`);
  assert.equal(missingConfirmation.status, 422);
  assert.equal(missingConfirmation.body.error, 'account_deletion_confirmation_required');

  const adminToken = await signToken({
    id: 'verification-admin',
    email: 'verification-admin@example.com',
    name: 'Verification Admin',
    role: 'admin',
  });
  const adminDeletion = await request(app)
    .delete('/api/v1/auth/me')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ confirmation: 'DELETE' });
  assert.equal(adminDeletion.status, 403);
  assert.equal(adminDeletion.body.error, 'account_deletion_unavailable');
});

test('Google sign-in identifies a token issued for another OAuth client before database access', async () => {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const mismatchedToken = [
    encode({ alg: 'RS256', typ: 'JWT' }),
    encode({ aud: env.GOOGLE_CLIENT_ID ? 'different-oauth-client.apps.googleusercontent.com' : 'unconfigured-client.apps.googleusercontent.com' }),
    'test-signature',
  ].join('.');

  const res = await request(app)
    .post('/api/v1/auth/google')
    .send({ idToken: mismatchedToken });

  assert.equal(res.status, env.GOOGLE_CLIENT_ID ? 401 : 503);
  assert.equal(res.body.error, env.GOOGLE_CLIENT_ID ? 'google_client_mismatch' : 'google_auth_unavailable');
  if (env.GOOGLE_CLIENT_ID) assert.match(res.body.message, /backend expects/);
});

test('GET /api/v1/readiness reports database availability', async () => {
  const res = await request(app).get('/api/v1/readiness');
  assert.equal(res.status, 503);
  assert.equal(res.body.ok, false);
  assert.equal(res.body.database, 'unavailable');
});

test('metrics group content slugs into one bounded endpoint dimension', async () => {
  const first = await request(app).get('/api/v1/blogs/slug/metrics-sre-first');
  const second = await request(app).get('/api/v1/blogs/slug/metrics-sre-second');
  assert.equal(first.status, 503);
  assert.equal(second.status, 503);

  const snapshot = await request(app).get('/api/v1/observability/snapshot');
  const endpoint = snapshot.body.requests.endpoints['GET /api/v1/blogs/slug/:slug'];
  assert.ok(endpoint.count >= 2);
  assert.equal(Object.keys(snapshot.body.requests.endpoints).some((key) => key.includes('metrics-sre-')), false);
});

test('metrics endpoint dimensions stay within their configured bound', async () => {
  for (let index = 0; index < 150; index += 1) {
    const metricRequest = metrics.requestStarted({
      method: 'GET',
      path: `/api/v1/metric-cardinality-${index}`,
    } as Request);
    metrics.requestCompleted(metricRequest.key, 404, metricRequest.startedAt);
  }

  const snapshot = metrics.snapshot({});
  assert.ok(Object.keys(snapshot.requests.endpoints).length <= 128);
  assert.ok(snapshot.requests.endpoints['OTHER <other>'].count >= 1);
});

test('observability exposes live backend, frontend, process, and database metrics', async () => {
  const frontendMetric = await request(app)
    .post('/api/v1/observability/frontend')
    .send({ kind: 'web_vital', name: 'FCP', value: 123.4, path: '/' });
  assert.equal(frontendMetric.status, 204);

  const res = await request(app).get('/api/v1/observability/snapshot');
  assert.equal(res.status, 200);
  assert.equal(typeof res.body.observedAt, 'string');
  assert.equal(typeof res.body.process.cpu.percent, 'number');
  assert.equal(typeof res.body.process.eventLoop.p95Ms, 'number');
  assert.equal(typeof res.body.requests.statusCodes['200'], 'number');
  assert.equal(res.body.frontend.webVitals.FCP.count >= 1, true);
  assert.equal(typeof res.body.database.p95Ms, 'number');
  assert.equal(typeof res.body.database.readiness.status, 'string');
});

test('frontend telemetry stays available when the shared rate-limit table is not installed', async () => {
  const responses = await Promise.all(
    Array.from({ length: 5 }, () => request(app)
      .post('/api/v1/observability/frontend')
      .send({ kind: 'web_vital', name: 'FCP', value: 123.4, path: '/' })),
  );

  assert.deepEqual(responses.map((response) => response.status), [204, 204, 204, 204, 204]);
});

test('GET /api/v1/blogs fails with 503 when the database is unavailable', async () => {
  const res = await request(app).get('/api/v1/blogs');
  assert.equal(res.status, 503);
  assert.equal(res.body.error, 'content_service_unavailable');
});

test('POST /api/v1/newsletter/subscribe fails with 503 when the database is unavailable', async () => {
  const res = await request(app)
    .post('/api/v1/newsletter/subscribe')
    .send({ email: 'reader@example.com', source: 'smoke-test' });

  assert.equal(res.status, 503);
  assert.equal(res.body.error, 'subscription_service_unavailable');
});

test('POST /api/v1/contact fails with 503 when the database is unavailable', async () => {
  const res = await request(app)
    .post('/api/v1/contact')
    .send({
      name: 'Test User',
      email: 'contact@example.com',
      subject: 'Hello',
      message: 'This is a smoke test message.',
    });

  assert.equal(res.status, 503);
  assert.equal(res.body.error, 'contact_service_unavailable');
});

test('shared rate-limit database socket failures return a retryable service error', async (context) => {
  const previousMode = process.env.BACKEND_TEST_DATABASE_MODE;
  process.env.BACKEND_TEST_DATABASE_MODE = 'available';
  context.mock.method(db, 'query', async () => {
    const error = Object.assign(new AggregateError([], 'database socket access denied'), { code: 'EACCES' });
    throw error;
  });
  context.mock.method(db, 'logApiError', async () => undefined);

  try {
    const response = await request(app)
      .post('/api/v1/contact')
      .send({
        name: 'Boundary Test',
        email: 'boundary@example.invalid',
        subject: 'Database outage path',
        message: 'This request exercises a database-backed rate limiter failure.',
      });

    assert.equal(response.status, 503);
    assert.equal(response.body.error, 'service_unavailable');
    assert.equal(response.body.message, 'The service is temporarily unavailable. Please try again later.');
    assert.equal(response.headers['retry-after'], '5');
    assert.equal(JSON.stringify(response.body).includes('EACCES'), false);
  } finally {
    if (previousMode === undefined) delete process.env.BACKEND_TEST_DATABASE_MODE;
    else process.env.BACKEND_TEST_DATABASE_MODE = previousMode;
  }
});

test('GET /api/v1/media/stream requires the token header', async () => {
  const res = await request(app).get('/api/v1/media/stream');

  assert.equal(res.status, 401);
  assert.equal(res.body.error, 'missing_media_token');
});

test('POST /api/v1/contact drops honeypot submissions before database access', async () => {
  const res = await request(app)
    .post('/api/v1/contact')
    .send({
      name: 'Bot User',
      email: 'bot@example.com',
      subject: 'Automated message',
      message: 'This should not be persisted.',
      website: 'https://bot.example.com',
    });

  assert.equal(res.status, 202);
  assert.equal(res.body.success, true);
});

test('POST /api/v1/newsletter/subscribe drops honeypot submissions before database access', async () => {
  const res = await request(app)
    .post('/api/v1/newsletter/subscribe')
    .send({ email: 'bot@example.com', website: 'https://bot.example.com' });

  assert.equal(res.status, 202);
  assert.equal(res.body.success, true);
});

test('POST /api/v1/newsletter/resend-confirmation validates email and hides honeypot submissions', async () => {
  const invalid = await request(app)
    .post('/api/v1/newsletter/resend-confirmation')
    .send({ email: 'not-an-email' });
  assert.equal(invalid.status, 422);

  const honeypot = await request(app)
    .post('/api/v1/newsletter/resend-confirmation')
    .send({ email: 'bot@example.com', website: 'https://bot.example.com' });
  assert.equal(honeypot.status, 202);
  assert.match(honeypot.body.message, /if an unconfirmed subscription exists/i);
});

test('newsletter token actions do not mutate state on GET and require valid POST tokens', async () => {
  for (const action of ['confirm', 'unsubscribe']) {
    const scannedLink = await request(app).get(`/api/v1/newsletter/${action}?token=${'a'.repeat(43)}`);
    assert.equal(scannedLink.status, 404);
    assert.equal(scannedLink.body.error, 'not_found');

    const invalidPost = await request(app).post(`/api/v1/newsletter/${action}`).send({ token: 'invalid' });
    assert.equal(invalidPost.status, 400);
    assert.equal(invalidPost.body.error, 'invalid_subscription_token');
    assert.equal(invalidPost.headers['cache-control'], 'no-store');
    assert.equal(invalidPost.headers['referrer-policy'], 'no-referrer');
  }
});

test('GET /api/v1/search validates query before database access', async () => {
  const invalidQueries = [
    '/api/v1/search?q=',
    '/api/v1/search?q=%20%20',
    '/api/v1/search?q=x',
    `/api/v1/search?q=${'a'.repeat(161)}`,
    '/api/v1/search?q=history&type=users',
    '/api/v1/search?q=history&limit=51',
    '/api/v1/search?q=history&offset=-1',
    '/api/v1/search?q=history&offset=100001',
  ];
  const responses = await Promise.all(invalidQueries.map(path => request(app).get(path)));
  for (const response of responses) {
    assert.equal(response.status, 422);
    assert.equal(response.body.error, 'invalid_search_query');
  }

  // The query language receives data values through bind parameters; unusual text is accepted
  // as input and reaches the configured unavailable-database response in smoke mode.
  for (const query of ['  Bengal   history  ', 'বাংলা ইতিহাস', `history ${'x'.repeat(140)}`, `history !@#$%^&*()`]) {
    const response = await request(app).get(`/api/v1/search?q=${encodeURIComponent(query)}`);
    assert.equal(response.status, 503);
    assert.equal(response.body.error, 'content_service_unavailable');
  }
});

test('editorial AI suggestions require admin authentication', async () => {
  const response = await request(app)
    .post('/api/v1/admin/ai/editorial-suggestions')
    .send({ kind: 'blog', title: 'A story', content: 'Draft content.' });
  assert.equal(response.status, 401);
  assert.equal(response.body.error, 'unauthorized');
});

test('POST /api/v1/admin/login issues a JWT for valid credentials', async () => {
  const res = await request(app)
    .post('/api/v1/admin/login')
    .send({ email: 'admin@voiceofdigi.org', password: 'admin123' });

  assert.equal(res.status, 200);
  assert.ok(typeof res.body.token === 'string');
  assert.equal(res.body.user.email, 'admin@voiceofdigi.org');
});

test('POST /api/v1/admin/login rejects invalid credentials', async () => {
  const res = await request(app)
    .post('/api/v1/admin/login')
    .send({ email: 'admin@voiceofdigi.org', password: 'wrong-password' });

  assert.equal(res.status, 401);
  assert.equal(res.body.error, 'invalid_credentials');
});
