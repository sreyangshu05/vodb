import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { verifyNewsletterWebhookSignature } from '../services/newsletterWebhook.js';

test('newsletter webhook verifies HMAC over the exact raw request bytes', () => {
  const secret = 'local-test-newsletter-webhook-secret';
  const rawBody = Buffer.from('{"event":"delivered","email":"reader@example.com"}');
  const signature = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');

  assert.equal(verifyNewsletterWebhookSignature(rawBody, signature, secret), true);
  assert.equal(verifyNewsletterWebhookSignature(Buffer.from('{ "event":"delivered","email":"reader@example.com"}'), signature, secret), false);
  assert.equal(verifyNewsletterWebhookSignature(rawBody, signature.slice(2), secret), false);
  assert.equal(verifyNewsletterWebhookSignature(rawBody, signature, `${secret}-wrong`), false);
});
