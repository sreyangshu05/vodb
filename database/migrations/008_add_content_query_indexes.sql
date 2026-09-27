BEGIN;

CREATE INDEX IF NOT EXISTS ix_blog_posts_public_feed
    ON blog_posts (published_at DESC, created_at DESC, id)
    WHERE published = TRUE AND moderation_status = 'approved';

CREATE INDEX IF NOT EXISTS ix_events_public_feed
    ON events (event_date ASC, created_at DESC, id)
    WHERE published = TRUE AND moderation_status = 'approved';

CREATE INDEX IF NOT EXISTS ix_blog_posts_admin_created
    ON blog_posts (created_at DESC, id);

CREATE INDEX IF NOT EXISTS ix_events_admin_created
    ON events (created_at DESC, id);

COMMIT;
