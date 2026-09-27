CREATE TABLE IF NOT EXISTS protected_media (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  storage_url TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS protected_media_active_idx ON protected_media (id) WHERE is_active = TRUE;

CREATE TABLE IF NOT EXISTS protected_media_access_log (
  id BIGSERIAL PRIMARY KEY,
  media_id UUID NOT NULL REFERENCES protected_media(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  ip_address INET,
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS protected_media_access_log_media_idx ON protected_media_access_log (media_id, created_at DESC);
