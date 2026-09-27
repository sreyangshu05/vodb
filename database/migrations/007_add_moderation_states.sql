BEGIN;

ALTER TABLE blog_posts
    ADD COLUMN IF NOT EXISTS moderation_status VARCHAR(32) NOT NULL DEFAULT 'draft';

ALTER TABLE events
    ADD COLUMN IF NOT EXISTS moderation_status VARCHAR(32) NOT NULL DEFAULT 'draft';

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'blog_posts_moderation_status_check'
          AND conrelid = 'blog_posts'::regclass
    ) THEN
        ALTER TABLE blog_posts ADD CONSTRAINT blog_posts_moderation_status_check
            CHECK (moderation_status IN ('draft', 'pending_review', 'approved', 'rejected', 'archived'));
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'events_moderation_status_check'
          AND conrelid = 'events'::regclass
    ) THEN
        ALTER TABLE events ADD CONSTRAINT events_moderation_status_check
            CHECK (moderation_status IN ('draft', 'pending_review', 'approved', 'rejected', 'archived'));
    END IF;
END $$;

UPDATE blog_posts SET moderation_status = CASE WHEN published THEN 'approved' ELSE 'draft' END;
UPDATE events SET moderation_status = CASE WHEN published THEN 'approved' ELSE 'draft' END;

CREATE INDEX IF NOT EXISTS ix_blog_posts_moderation_status ON blog_posts (moderation_status, updated_at DESC);
CREATE INDEX IF NOT EXISTS ix_events_moderation_status ON events (moderation_status, updated_at DESC);

COMMIT;