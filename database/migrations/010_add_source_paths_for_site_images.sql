BEGIN;

ALTER TABLE media_assets
  ADD COLUMN IF NOT EXISTS source_path TEXT;

ALTER TABLE media_assets DROP CONSTRAINT IF EXISTS media_assets_byte_size_check;
ALTER TABLE media_assets
  ADD CONSTRAINT media_assets_byte_size_check CHECK (byte_size > 0 AND byte_size <= 26214400);

CREATE UNIQUE INDEX IF NOT EXISTS media_assets_source_path_uq
  ON media_assets (source_path) WHERE source_path IS NOT NULL;

COMMIT;
