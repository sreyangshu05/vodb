BEGIN;

CREATE INDEX IF NOT EXISTS ix_blog_posts_published_search
  ON blog_posts USING GIN (
    to_tsvector(
      'simple'::regconfig,
      COALESCE(title, '') || ' ' || COALESCE(meta_title, '') || ' ' || COALESCE(meta_description, '') || ' ' || COALESCE(content, '')
    )
  )
  WHERE published = TRUE AND moderation_status = 'approved';

CREATE INDEX IF NOT EXISTS ix_events_published_search
  ON events USING GIN (
    to_tsvector(
      'simple'::regconfig,
      COALESCE(title, '') || ' ' || COALESCE(location, '') || ' ' || COALESCE(description, '')
    )
  )
  WHERE published = TRUE AND moderation_status = 'approved';

COMMIT;
