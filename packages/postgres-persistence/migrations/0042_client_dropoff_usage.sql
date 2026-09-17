BEGIN;
SET LOCAL ROLE kavaroutes_migration;

-- A client's destination directory is operational history, not free-text notes.
-- Usage is updated only when Dispatch schedules an outbound trip for that client.
ALTER TABLE intake.client_dropoff
  DROP CONSTRAINT client_dropoff_ordinal_check;
ALTER TABLE intake.client_dropoff
  ADD CONSTRAINT client_dropoff_ordinal_check CHECK (ordinal BETWEEN 1 AND 100),
  ADD COLUMN usage_count integer NOT NULL DEFAULT 0 CHECK (usage_count >= 0),
  ADD COLUMN last_used_at timestamptz;

GRANT UPDATE (usage_count, last_used_at) ON intake.client_dropoff TO kavaroutes_api;

COMMIT;
