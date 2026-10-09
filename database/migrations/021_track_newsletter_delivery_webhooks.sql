BEGIN;

CREATE TABLE IF NOT EXISTS newsletter_delivery_webhook_events (
  event_id VARCHAR(200) PRIMARY KEY,
  event_type VARCHAR(16) NOT NULL CHECK (event_type IN ('delivered', 'bounce', 'complaint')),
  occurred_at TIMESTAMPTZ NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS newsletter_delivery_webhook_events_received_idx
  ON newsletter_delivery_webhook_events (received_at, event_id);

COMMIT;
