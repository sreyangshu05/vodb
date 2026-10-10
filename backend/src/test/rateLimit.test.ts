import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import test from 'node:test';
import { createRateLimiter } from '../middleware/rateLimit.js';
import { getTrustedProxyHops } from '../middleware/proxyTrust.js';

function createTestApp(options: Parameters<typeof createRateLimiter>[0], renderMarker?: string) {
  const app = express();
  app.set('trust proxy', getTrustedProxyHops(renderMarker));
  app.use(express.json());
  app.all('/limited', createRateLimiter(options), (req, res) => {
    res.json({ ok: true, ip: req.ip });
  });
  return app;
}

test('repeated requests return 429 and a positive Retry-After when the IP bucket is full', async () => {
  const app = createTestApp({ windowMs: 60_000, max: 2, keyPrefix: 'rate-test-repeated' }, 'false');

  assert.equal((await request(app).get('/limited')).status, 200);
  assert.equal((await request(app).get('/limited')).status, 200);
  const limited = await request(app).get('/limited');

  assert.equal(limited.status, 429);
  assert.equal(limited.body.error, 'rate_limited');
  assert.match(limited.headers['retry-after'] ?? '', /^[1-9]\d*$/);
});

test('concurrent requests cannot exceed the in-process limit', async () => {
  const app = createTestApp({ windowMs: 60_000, max: 4, keyPrefix: 'rate-test-concurrent' }, 'false');
  const responses = await Promise.all(Array.from({ length: 20 }, () => request(app).get('/limited')));

  assert.equal(responses.filter((response) => response.status === 200).length, 4);
  assert.equal(responses.filter((response) => response.status === 429).length, 16);
});

test('the in-process limit recovers after its window expires', async () => {
  const app = createTestApp({ windowMs: 100, max: 1, keyPrefix: 'rate-test-recovery' }, 'false');

  assert.equal((await request(app).get('/limited')).status, 200);
  assert.equal((await request(app).get('/limited')).status, 429);
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal((await request(app).get('/limited')).status, 200);
});

test('Render proxy mode uses the rightmost forwarded address so a spoofed prefix cannot evade the IP bucket', async () => {
  assert.equal(getTrustedProxyHops('true'), 1);
  const app = createTestApp({ windowMs: 60_000, max: 1, keyPrefix: 'rate-test-render-proxy' }, 'true');
  const first = await request(app)
    .get('/limited')
    .set('X-Forwarded-For', '198.51.100.10, 203.0.113.25');
  const second = await request(app)
    .get('/limited')
    .set('X-Forwarded-For', '198.51.100.11, 203.0.113.25');

  assert.equal(first.status, 200);
  assert.equal(first.body.ip, '203.0.113.25');
  assert.equal(second.status, 429);
});

test('non-Render mode ignores untrusted forwarded headers', async () => {
  assert.equal(getTrustedProxyHops('false'), false);
  const app = createTestApp({ windowMs: 60_000, max: 1, keyPrefix: 'rate-test-untrusted-proxy' }, 'false');
  const first = await request(app).get('/limited').set('X-Forwarded-For', '198.51.100.10');
  const second = await request(app).get('/limited').set('X-Forwarded-For', '198.51.100.11');

  assert.equal(first.status, 200);
  assert.equal(second.status, 429);
  assert.notEqual(first.body.ip, '198.51.100.10');
});

test('account identity limits still apply when requests arrive from different IP addresses', async () => {
  const app = createTestApp({
    windowMs: 60_000,
    max: 10,
    identityMax: 1,
    identity: (req) => typeof req.body?.email === 'string' ? req.body.email : undefined,
    keyPrefix: 'rate-test-account',
  }, 'true');
  const first = await request(app)
    .post('/limited')
    .set('X-Forwarded-For', '192.0.2.10, 203.0.113.10')
    .send({ email: ' Reader@Example.test ' });
  const second = await request(app)
    .post('/limited')
    .set('X-Forwarded-For', '192.0.2.11, 203.0.113.11')
    .send({ email: 'reader@example.test' });

  assert.equal(first.status, 200);
  assert.equal(second.status, 429);
});
