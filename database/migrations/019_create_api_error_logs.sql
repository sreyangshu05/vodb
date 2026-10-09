BEGIN;

CREATE TABLE IF NOT EXISTS api_error_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    endpoint TEXT NOT NULL,
    error_message TEXT NOT NULL,
    user_id TEXT
);

CREATE INDEX IF NOT EXISTS ix_api_error_logs_occurred_at
    ON api_error_logs (occurred_at DESC);

CREATE INDEX IF NOT EXISTS ix_api_error_logs_endpoint_occurred_at
    ON api_error_logs (endpoint, occurred_at DESC);

CREATE INDEX IF NOT EXISTS ix_api_error_logs_user_id_occurred_at
    ON api_error_logs (user_id, occurred_at DESC)
    WHERE user_id IS NOT NULL;

COMMIT;
