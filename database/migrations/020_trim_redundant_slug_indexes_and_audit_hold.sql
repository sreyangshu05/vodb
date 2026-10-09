BEGIN;

-- The UNIQUE constraints declared in migration 001 already provide unique
-- indexes for each slug. These separately named indexes duplicate that work.
DROP INDEX IF EXISTS uq_blog_posts_slug;
DROP INDEX IF EXISTS uq_events_slug;

-- Audit records are retained for seven years by the maintenance policy.
-- A legal hold exempts a record from automated retention cleanup.
ALTER TABLE audit_events
  ADD COLUMN IF NOT EXISTS legal_hold BOOLEAN NOT NULL DEFAULT FALSE;

-- The retention task filters/orders by created_at, unlike access checks which
-- use the existing media_id-leading index.
CREATE INDEX IF NOT EXISTS protected_media_access_log_retention_idx
  ON protected_media_access_log (created_at, id);

COMMIT;
