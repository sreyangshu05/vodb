BEGIN;

DELETE FROM password_reset_otps
WHERE id IN (
  SELECT id
  FROM (
    SELECT id, row_number() OVER (PARTITION BY user_id ORDER BY created_at DESC, id DESC) AS duplicate_number
    FROM password_reset_otps
  ) duplicate_otps
  WHERE duplicate_number > 1
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_password_reset_otps_user_id
  ON password_reset_otps (user_id);

ALTER TABLE password_reset_otps
  ADD COLUMN IF NOT EXISTS failed_attempts INTEGER NOT NULL DEFAULT 0
  CHECK (failed_attempts BETWEEN 0 AND 5),
  ADD COLUMN IF NOT EXISTS locked_until TIMESTAMPTZ;

ALTER TABLE reader_email_verification_otps
  ADD COLUMN IF NOT EXISTS failed_attempts INTEGER NOT NULL DEFAULT 0
  CHECK (failed_attempts BETWEEN 0 AND 5),
  ADD COLUMN IF NOT EXISTS locked_until TIMESTAMPTZ;

COMMIT;
