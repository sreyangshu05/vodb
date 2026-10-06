ALTER TABLE events
  ADD COLUMN IF NOT EXISTS all_day BOOLEAN NOT NULL DEFAULT FALSE;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'events_all_day_utc_midnight_check'
      AND conrelid = 'events'::regclass
  ) THEN
    ALTER TABLE events
      ADD CONSTRAINT events_all_day_utc_midnight_check
      CHECK (
        NOT all_day OR (
          event_date = date_trunc('day', event_date AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
          AND (
            ends_at IS NULL
            OR ends_at = date_trunc('day', ends_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
          )
        )
      );
  END IF;
END $$;
