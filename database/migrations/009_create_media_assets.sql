BEGIN;

CREATE TABLE IF NOT EXISTS media_assets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  original_name TEXT NOT NULL,
  mime_type TEXT NOT NULL CHECK (mime_type IN ('image/jpeg', 'image/png', 'image/webp')),
  byte_size INTEGER NOT NULL CHECK (byte_size > 0 AND byte_size <= 5242880),
  image_data BYTEA NOT NULL,
  alt_text TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE blog_posts ADD COLUMN IF NOT EXISTS image_media_id UUID REFERENCES media_assets(id) ON DELETE SET NULL;
ALTER TABLE events ADD COLUMN IF NOT EXISTS image_media_id UUID REFERENCES media_assets(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS blog_posts_image_media_idx ON blog_posts (image_media_id) WHERE image_media_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS events_image_media_idx ON events (image_media_id) WHERE image_media_id IS NOT NULL;

COMMIT;
