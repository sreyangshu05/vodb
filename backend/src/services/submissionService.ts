import { createHash, randomBytes } from 'node:crypto';
import { db } from '../lib/db.js';
import { AppError } from '../utils/errors.js';
import { emailSchema } from '../lib/validators.js';
import type { ContactInquiryInput, NewsletterSubscriptionInput } from '../types/api.js';

function isDbUnavailable(error: unknown): boolean {
  return error instanceof Error && (
    /ECONNREFUSED|connect ECONNREFUSED|password authentication failed|authentication failed|database.*(not|is).*available|timeout of|connection.*refused|connection terminated|could not connect to server|server.*(down|unavailable)|FATAL/i.test(error.message) ||
    /Client has encountered a connection error|password authentication failed|could not connect to server/i.test(String(error))
  );
}

export async function createNewsletterSubscription(input: NewsletterSubscriptionInput) {
  const email = emailSchema.parse(input.email);
  const source = input.source?.trim() || 'website';
  const confirmationToken = randomBytes(32).toString('base64url');
  const confirmationTokenHash = createHash('sha256').update(confirmationToken).digest('hex');

  try {
    const result = await db.query<{ id: string; email: string; status: string; confirmed_at: string | null }>(`
      INSERT INTO newsletter_subscriptions (email, status, source, consented_at, confirmed_at, confirmation_token_hash, created_at, updated_at)
      VALUES ($1, 'pending', $2, NOW(), NULL, $3, NOW(), NOW())
      ON CONFLICT (lower(email)) DO UPDATE SET
        status = EXCLUDED.status,
        source = EXCLUDED.source,
        confirmation_token_hash = EXCLUDED.confirmation_token_hash,
        unsubscribed_at = NULL,
        consented_at = NOW(),
        updated_at = NOW()
      WHERE newsletter_subscriptions.status <> 'active'
      RETURNING id, email, status, confirmed_at, confirmation_token_hash
    `, [email, source, confirmationTokenHash]);

    if (!result.rows[0]) {
      throw new AppError(409, 'newsletter_already_registered', 'This email is already subscribed.');
    }

    return { ...result.rows[0], confirmationToken };
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }

    if (isDbUnavailable(error)) {
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
     SET status = 'active', confirmed_at = COALESCE(confirmed_at, NOW()), unsubscribed_at = NULL, updated_at = NOW()
     WHERE confirmation_token_hash = $1
       AND status IN ('pending', 'active')
     RETURNING id`,
    [hashNewsletterToken(token)],
  );
  if (!result.rows[0]) throw new AppError(400, 'invalid_subscription_token', 'This subscription link is invalid or expired.');
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
     SET status = 'unsubscribed', unsubscribed_at = NOW(), updated_at = NOW()
     WHERE confirmation_token_hash = $1
       AND status <> 'unsubscribed'
     RETURNING id`,
    [hashNewsletterToken(token)],
  );
  if (!result.rows[0]) throw new AppError(400, 'invalid_subscription_token', 'This unsubscribe link is invalid or expired.');
}

export async function processNewsletterDeliveryEvent(event: 'delivered' | 'bounce' | 'complaint', email: string) {
  const status = event === 'bounce' ? 'bounced' : event === 'complaint' ? 'complained' : null;
  const result = await db.query<{ id: string }>(
    status
      ? `UPDATE newsletter_subscriptions
         SET status = $1, updated_at = NOW(), last_delivery_at = NOW()
         WHERE lower(email) = lower($2) AND status NOT IN ('unsubscribed', 'complained')
         RETURNING id`
      : `UPDATE newsletter_subscriptions
         SET last_delivery_at = NOW(), updated_at = NOW()
         WHERE lower(email) = lower($1)
         RETURNING id`,
    status ? [status, email] : [email],
  );
}

export async function createContactInquiry(input: ContactInquiryInput) {
  const parsed = {
    name: input.name.trim(),
    email: emailSchema.parse(input.email),
    subject: input.subject.trim(),
    message: input.message.trim(),
  };

  try {
    const result = await db.query<{ id: string; status: string }>(`
      INSERT INTO contact_inquiries (name, email, subject, message, status, source, created_at, updated_at)
      VALUES ($1, $2, $3, $4, 'received', 'website', NOW(), NOW())
      RETURNING id, status
    `, [parsed.name, parsed.email, parsed.subject, parsed.message]);

    return result.rows[0];
  } catch (error) {
    if (isDbUnavailable(error)) {
      throw new AppError(503, 'contact_service_unavailable', 'The contact service is temporarily unavailable.');
    }

    throw error;
  }
}
