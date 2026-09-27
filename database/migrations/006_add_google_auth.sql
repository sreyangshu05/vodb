BEGIN;

ALTER TABLE users
    ADD COLUMN IF NOT EXISTS auth_provider VARCHAR(32) NOT NULL DEFAULT 'password',
    ADD COLUMN IF NOT EXISTS google_subject VARCHAR(255);

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'users_auth_provider_check'
          AND conrelid = 'users'::regclass
    ) THEN
        ALTER TABLE users
            ADD CONSTRAINT users_auth_provider_check CHECK (auth_provider IN ('password', 'google'));
    END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_users_google_subject
    ON users (google_subject)
    WHERE google_subject IS NOT NULL;

COMMIT;