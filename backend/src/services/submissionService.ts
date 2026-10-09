import { createHash, randomBytes } from 'node:crypto';
import { db } from '../lib/db.js';
import { AppError } from '../utils/errors.js';
import { isDatabaseUnavailable } from '../utils/databaseErrors.js';
import { emailSchema } from '../lib/validators.js';
import type { ContactInquiryInput, NewsletterSubscriptionInput } from '../types/api.js';

export async function createNewsletterSubscription(input: NewsletterSubscriptionInput) {
  const email = emailSchema.parse(input.email);
  const source = input.source?.trim() || 'website';
  const confirmationToken = randomBytes(32).toString('base64url');
  const confirmationTokenHash = createHash('sha256').update(confirmationToken).digest('hex');
  const unsubscribeToken = randomBytes(32).toString('base64url');
  const unsubscribeTokenHash = createHash('sha256').update(unsubscribeToken).digest('hex');

  try {
    const result = await db.query<{ id: string; email: string; status: string; confirmed_at: string | null }>(`
      INSERT INTO newsletter_subscriptions (email, status, source, consented_at, confirmed_at, confirmation_token_hash, confirmation_token_expires_at, unsubscribe_token_hash, created_at, updated_at)
      VALUES ($1, 'pending', $2, NOW(), NULL, $3, NOW() + INTERVAL '24 hours', $4, NOW(), NOW())
      ON CONFLICT (lower(email)) DO UPDATE SET
        status = EXCLUDED.status,
        source = EXCLUDED.source,
        confirmation_token_hash = EXCLUDED.confirmation_token_hash,
        confirmation_token_expires_at = EXCLUDED.confirmation_token_expires_at,
        unsubscribe_token_hash = EXCLUDED.unsubscribe_token_hash,
        unsubscribed_at = NULL,
        consented_at = NOW(),
        updated_at = NOW()
      WHERE newsletter_subscriptions.status <> 'active'
        AND (
          newsletter_subscriptions.status <> 'pending'
          OR newsletter_subscriptions.confirmation_token_hash IS NULL
          OR newsletter_subscriptions.confirmation_token_expires_at IS NULL
          OR newsletter_subscriptions.confirmation_token_expires_at <= NOW()
        )
      RETURNING id, email, status, confirmed_at
    `, [email, source, confirmationTokenHash, unsubscribeTokenHash]);

    if (!result.rows[0]) {
      throw new AppError(409, 'newsletter_already_registered', 'This email is already subscribed.');
    }

    return { ...result.rows[0], confirmationToken, unsubscribeToken };
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }

    if (isDatabaseUnavailable(error)) {
      throw new AppError(503, 'subscription_service_unavailable', 'The newsletter service is temporarily unavailable.');
    }

    throw error;
  }
}

function hashNewsletterToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export async function confirmNewsletterSubscription(token: string) {
  const result = await db.query<{ id: string }>(
    `UPDATE newsletter_subscriptions
     SET status = 'active', confirmed_at = COALESCE(confirmed_at, NOW()), unsubscribed_at = NULL,
         confirmation_token_hash = NULL, confirmation_token_expires_at = NULL, updated_at = NOW()
     WHERE confirmation_token_hash = $1
       AND status = 'pending'
       AND confirmation_token_expires_at > NOW()
     RETURNING id`,
    [hashNewsletterToken(token)],
  );
  if (!result.rows[0]) throw new AppError(400, 'invalid_subscription_token', 'This subscription link is invalid or expired.');
}

export async function resendPendingNewsletterConfirmation(emailInput: string) {
  const email = emailSchema.parse(emailInput);
  const confirmationToken = randomBytes(32).toString('base64url');
  const unsubscribeToken = randomBytes(32).toString('base64url');
  const result = await db.query<{
    email: string;
    previous_confirmation_token_hash: string | null;
    previous_confirmation_token_expires_at: string | null;
    previous_unsubscribe_token_hash: string | null;
  }>(
    `WITH pending AS (
       SELECT id, confirmation_token_hash, confirmation_token_expires_at, unsubscribe_token_hash
       FROM newsletter_subscriptions
       WHERE lower(email) = lower($3)
         AND status = 'pending'
         AND updated_at <= NOW() - INTERVAL '30 seconds'
       FOR UPDATE
     )
     UPDATE newsletter_subscriptions subscription
     SET confirmation_token_hash = $1,
         confirmation_token_expires_at = NOW() + INTERVAL '24 hours',
         unsubscribe_token_hash = $2,
         updated_at = NOW()
     FROM pending
     WHERE subscription.id = pending.id
     RETURNING subscription.email,
       pending.confirmation_token_hash AS previous_confirmation_token_hash,
       pending.confirmation_token_expires_at AS previous_confirmation_token_expires_at,
       pending.unsubscribe_token_hash AS previous_unsubscribe_token_hash`,
    [createHash('sha256').update(confirmationToken).digest('hex'), createHash('sha256').update(unsubscribeToken).digest('hex'), email],
  );
  const row = result.rows[0];
  return row ? {
    email: row.email,
    confirmationToken,
    unsubscribeToken,
    previousTokenState: {
      confirmationTokenHash: row.previous_confirmation_token_hash,
      confirmationTokenExpiresAt: row.previous_confirmation_token_expires_at,
      unsubscribeTokenHash: row.previous_unsubscribe_token_hash,
    },
  } : null;
}

export async function restorePendingNewsletterConfirmation(
  email: string,
  confirmationToken: string,
  previousTokenState: {
    confirmationTokenHash: string | null;
    confirmationTokenExpiresAt: string | null;
    unsubscribeTokenHash: string | null;
  },
): Promise<void> {
  await db.query(
    `UPDATE newsletter_subscriptions
     SET confirmation_token_hash = $1,
         confirmation_token_expires_at = $2,
         unsubscribe_token_hash = $3,
         updated_at = NOW()
     WHERE lower(email) = lower($4)
       AND status = 'pending'
       AND confirmation_token_hash = $5`,
    [
      previousTokenState.confirmationTokenHash,
      previousTokenState.confirmationTokenExpiresAt,
      previousTokenState.unsubscribeTokenHash,
      email,
      createHash('sha256').update(confirmationToken).digest('hex'),
    ],
  );
}

export async function discardNewsletterSubscription(token: string): Promise<void> {
  await db.query(
    `DELETE FROM newsletter_subscriptions
     WHERE confirmation_token_hash = $1 AND status = 'pending'`,
    [hashNewsletterToken(token)],
  );
}

export async function unsubscribeNewsletter(token: string) {
  const result = await db.query<{ id: string }>(
    `UPDATE newsletter_subscriptions
     SET status = 'unsubscribed', unsubscribed_at = NOW(), updated_at = NOW(),
         confirmation_token_hash = NULL, confirmation_token_expires_at = NULL, unsubscribe_token_hash = NULL
     WHERE (unsubscribe_token_hash = $1 OR (unsubscribe_token_hash IS NULL AND confirmation_token_hash = $1 AND status = 'active'))
       AND status <> 'unsubscribed'
     RETURNING id`,
    [hashNewsletterToken(token)],
  );
  if (!result.rows[0]) throw new AppError(400, 'invalid_subscription_token', 'This subscription link is invalid, expired, or already used.');
}

export async function processNewsletterDeliveryEvent(input: {
  eventId: string;
  occurredAt: string;
  event: 'delivered' | 'bounce' | 'complaint';
  email: string;
}) {
  await db.query(
    `WITH recorded AS (
       INSERT INTO newsletter_delivery_webhook_events (event_id, event_type, occurred_at)
       VALUES ($1, $2, $3)
       ON CONFLICT (event_id) DO NOTHING
       RETURNING event_id
     )
     UPDATE newsletter_subscriptions subscription
     SET status = CASE
           WHEN $2 = 'complaint' THEN 'complained'
           WHEN $2 = 'bounce' THEN 'bounced'
           ELSE subscription.status
         END,
         last_delivery_at = $3,
         updated_at = NOW()
     FROM recorded
     WHERE lower(subscription.email) = lower($4)
       AND subscription.status <> 'unsubscribed'
       AND ($2 <> 'bounce' OR subscription.status <> 'complained')
       AND (subscription.last_delivery_at IS NULL OR $3 >= subscription.last_delivery_at)`,
    [input.eventId, input.event, input.occurredAt, input.email],
  );
}

export async function createContactInquiry(input: ContactInquiryInput, idempotencyKey?: string) {
  const parsed = {
    name: input.name.trim(),
    email: emailSchema.parse(input.email),
    subject: input.subject.trim(),
    message: input.message.trim(),
  };
  const requestHash = createHash('sha256').update(JSON.stringify(parsed)).digest('hex');

  try {
    const result = await db.query<{ id: string; status: string; idempotency_request_hash?: string }>(`
      INSERT INTO contact_inquiries (
        name, email, subject, message, status, source, created_at, updated_at,
        idempotency_key, idempotency_request_hash
      )
      VALUES ($1, $2, $3, $4, 'received', 'website', NOW(), NOW(), $5, $6)
      ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
      RETURNING id, status, idempotency_request_hash
    `, [parsed.name, parsed.email, parsed.subject, parsed.message, idempotencyKey ?? null, idempotencyKey ? requestHash : null]);

    if (result.rows[0]) return { ...result.rows[0], replayed: false };
    if (!idempotencyKey) throw new Error('Contact inquiry was not inserted.');

    const existing = await db.query<{ id: string; status: string; idempotency_request_hash: string }>(
      `SELECT id, status, idempotency_request_hash
       FROM contact_inquiries
       WHERE idempotency_key = $1`,
      [idempotencyKey],
    );
    const prior = existing.rows[0];
    if (!prior) throw new Error('Idempotent contact inquiry could not be recovered.');
    if (prior.idempotency_request_hash !== requestHash) {
      throw new AppError(409, 'idempotency_key_reused', 'This submission key was already used for different contact details.');
    }
    return { id: prior.id, status: prior.status, replayed: true };
  } catch (error) {
    if (error instanceof AppError) throw error;
    if (isDatabaseUnavailable(error)) {
      throw new AppError(503, 'contact_service_unavailable', 'The contact service is temporarily unavailable.');
    }

    throw error;
  }
}
