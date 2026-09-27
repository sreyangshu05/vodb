BEGIN;

CREATE UNIQUE INDEX IF NOT EXISTS uq_blog_posts_slug ON blog_posts (slug);
CREATE INDEX IF NOT EXISTS ix_blog_posts_published_date ON blog_posts (published, published_at DESC) WHERE published = TRUE;

CREATE UNIQUE INDEX IF NOT EXISTS uq_events_slug ON events (slug);
CREATE INDEX IF NOT EXISTS ix_events_published_date ON events (published, event_date) WHERE published = TRUE;

CREATE UNIQUE INDEX IF NOT EXISTS uq_newsletter_email ON newsletter_subscriptions (lower(email));
CREATE INDEX IF NOT EXISTS ix_newsletter_status_created ON newsletter_subscriptions (status, created_at);

CREATE INDEX IF NOT EXISTS ix_contact_inquiries_status_created ON contact_inquiries (status, created_at DESC);
CREATE INDEX IF NOT EXISTS ix_audit_events_resource ON audit_events (resource_type, resource_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS ix_audit_events_occurred_at ON audit_events (occurred_at DESC);

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_blog_posts_updated_at ON blog_posts;
CREATE TRIGGER trg_blog_posts_updated_at
BEFORE UPDATE ON blog_posts
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_events_updated_at ON events;
CREATE TRIGGER trg_events_updated_at
BEFORE UPDATE ON events
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_newsletter_subscriptions_updated_at ON newsletter_subscriptions;
CREATE TRIGGER trg_newsletter_subscriptions_updated_at
BEFORE UPDATE ON newsletter_subscriptions
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_contact_inquiries_updated_at ON contact_inquiries;
CREATE TRIGGER trg_contact_inquiries_updated_at
BEFORE UPDATE ON contact_inquiries
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

COMMIT;
