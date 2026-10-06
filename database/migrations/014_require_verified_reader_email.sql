BEGIN;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS email_verified BOOLEAN NOT NULL DEFAULT TRUE;

-- Existing accounts predate verification and retain access. New password
-- registrations explicitly start unverified in the auth service.
CREATE TABLE IF NOT EXISTS reader_email_verification_otps (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  code_hash VARCHAR(64) NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ix_reader_email_verification_expiry
  ON reader_email_verification_otps (expires_at);

COMMIT;
