BEGIN;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS reader_preferences JSONB NOT NULL DEFAULT '{"topics": []}'::jsonb;

ALTER TABLE users
  ADD CONSTRAINT users_reader_preferences_valid
  CHECK (
    jsonb_typeof(reader_preferences) = 'object'
    AND jsonb_typeof(reader_preferences -> 'topics') = 'array'
  );

CREATE TABLE IF NOT EXISTS user_saved_pages (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  page_path VARCHAR(2048) NOT NULL,
  title VARCHAR(240) NOT NULL CHECK (length(trim(title)) > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, page_path),
  CHECK (page_path LIKE '/%' AND page_path NOT LIKE '//%')
);

CREATE INDEX IF NOT EXISTS ix_user_saved_pages_user_created
  ON user_saved_pages (user_id, created_at DESC);

COMMIT;
