BEGIN;
SET LOCAL ROLE kavaroutes_migration;

-- Planned appointment duration is an operational scheduling fact. It is retained on
-- the trip request so dispatch, driver projections, billing exports and later
-- planned-versus-actual wait analysis use one authoritative value.
ALTER TABLE intake.trip_request
  ADD COLUMN appointment_length_minutes integer NOT NULL DEFAULT 0
  CHECK (appointment_length_minutes BETWEEN 0 AND 1440);

COMMIT;
