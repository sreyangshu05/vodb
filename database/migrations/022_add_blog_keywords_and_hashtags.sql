BEGIN;

ALTER TABLE blog_posts
  ADD COLUMN IF NOT EXISTS keywords TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS hashtags TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS keywords_search_text TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS hashtags_search_text TEXT NOT NULL DEFAULT '';

-- Keep editorial keywords and hashtags searchable on public approved stories.
DROP INDEX IF EXISTS ix_blog_posts_published_search;
CREATE INDEX IF NOT EXISTS ix_blog_posts_published_search
  ON blog_posts USING GIN (
    to_tsvector(
      'simple'::regconfig,
      COALESCE(title, '') || ' ' || COALESCE(meta_title, '') || ' ' || COALESCE(meta_description, '') || ' ' ||
      COALESCE(keywords_search_text, '') || ' ' ||
      COALESCE(hashtags_search_text, '') || ' ' || COALESCE(content, '')
    )
  )
  WHERE published = TRUE AND moderation_status = 'approved';

COMMIT;
