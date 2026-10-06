BEGIN;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS token_version INTEGER NOT NULL DEFAULT 0
  CHECK (token_version >= 0);

ALTER TABLE contact_inquiries
  ADD COLUMN IF NOT EXISTS idempotency_key UUID,
  ADD COLUMN IF NOT EXISTS idempotency_request_hash TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS uq_contact_inquiries_idempotency_key
  ON contact_inquiries (idempotency_key)
  WHERE idempotency_key IS NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'contact_inquiries_idempotency_pair_valid'
      AND conrelid = 'contact_inquiries'::regclass
  ) THEN
    ALTER TABLE contact_inquiries
      ADD CONSTRAINT contact_inquiries_idempotency_pair_valid
      CHECK (
        (idempotency_key IS NULL AND idempotency_request_hash IS NULL)
        OR
        (idempotency_key IS NOT NULL AND idempotency_request_hash ~ '^[a-f0-9]{64}$')
      );
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS rate_limit_buckets (
  bucket_key CHAR(64) PRIMARY KEY,
  window_started_at TIMESTAMPTZ NOT NULL,
  request_count INTEGER NOT NULL CHECK (request_count > 0)
);

CREATE INDEX IF NOT EXISTS ix_rate_limit_buckets_window
  ON rate_limit_buckets (window_started_at);

COMMIT;
