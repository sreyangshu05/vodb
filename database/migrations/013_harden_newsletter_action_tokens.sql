BEGIN;

ALTER TABLE newsletter_subscriptions
  ADD COLUMN IF NOT EXISTS confirmation_token_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS unsubscribe_token_hash VARCHAR(128);

UPDATE newsletter_subscriptions
SET confirmation_token_expires_at = updated_at + INTERVAL '24 hours'
WHERE status = 'pending'
  AND confirmation_token_hash IS NOT NULL
  AND confirmation_token_expires_at IS NULL;

CREATE INDEX IF NOT EXISTS ix_newsletter_confirmation_token_expiry
  ON newsletter_subscriptions (confirmation_token_expires_at)
  WHERE status = 'pending' AND confirmation_token_hash IS NOT NULL;

COMMIT;