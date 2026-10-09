import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import request from 'supertest';
import { z } from 'zod';
import { errorHandler } from '../middleware/errorHandler.js';

function createErrorTestApp() {
  const app = express();
  app.get('/validation', (_req, _res, next) => {
    next(z.object({ email: z.string().email() }).safeParse({ email: 'private-user-input' }).error);
  });
  app.get('/statement-timeout', (_req, _res, next) => next({ code: '57014', message: 'private SQL text' }));
  app.use(errorHandler);
  return app;
}

test('forwarded schema errors return a safe 422 validation envelope', async () => {
  const response = await request(createErrorTestApp()).get('/validation');
  assert.equal(response.status, 422);
  assert.equal(response.body.error, 'invalid_request');
  assert.equal(response.body.message, 'Request validation failed.');
  assert.deepEqual(response.body.details.issues[0].path, ['email']);
  assert.equal(JSON.stringify(response.body).includes('private-user-input'), false);
});

test('PostgreSQL statement timeouts return a safe temporary-failure response', async () => {
  const response = await request(createErrorTestApp()).get('/statement-timeout');
  assert.equal(response.status, 503);
  assert.deepEqual(response.body, {
    error: 'database_query_timeout',
    message: 'The request took too long to complete. Please try again later.',
  });
  assert.equal(JSON.stringify(response.body).includes('private SQL text'), false);
});
