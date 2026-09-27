import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import app from '../server.js';
import { db } from '../lib/db.js';
import { waitForAuditWrites } from '../services/auditService.js';
import { signToken } from '../services/authService.js';
import { env } from '../config/env.js';
after(async () => {
    await waitForAuditWrites();
    await db.end();
});
test('GET /api/v1/health responds successfully', async () => {
    const res = await request(app).get('/api/v1/health');
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.ok(typeof res.headers['x-request-id'] === 'string');
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
test('authenticated non-admin users cannot access admin routes', async () => {
    const token = signToken({
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
test('Google sign-in identifies a token issued for another OAuth client', {
    skip: env.GOOGLE_CLIENT_ID ? false : 'GOOGLE_CLIENT_ID is not configured for this test environment',
}, async () => {
    const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const mismatchedToken = [
        encode({ alg: 'RS256', typ: 'JWT' }),
        encode({ aud: 'different-oauth-client.apps.googleusercontent.com' }),
        'test-signature',
    ].join('.');
    const res = await request(app)
        .post('/api/v1/auth/google')
        .send({ idToken: mismatchedToken });
    assert.equal(res.status, 401);
    assert.equal(res.body.error, 'google_client_mismatch');
    assert.match(res.body.message, /backend expects/);
});
test('GET /api/v1/readiness reports database availability', async () => {
    const res = await request(app).get('/api/v1/readiness');
    assert.equal(res.status, 503);
    assert.equal(res.body.ok, false);
    assert.equal(res.body.database, 'unavailable');
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
