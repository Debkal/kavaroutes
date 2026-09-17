BEGIN;
SET LOCAL ROLE kavaroutes_migration;

-- Removing a driver from a route is not a supersession: nothing replaces the
-- assignment, so the historical row is marked released instead of being superseded.
-- Every read that resolves "the current assignment" also excludes released rows.
ALTER TABLE dispatch.assignment ADD COLUMN released_at timestamptz;
ALTER TABLE dispatch.assignment ADD COLUMN release_reason text
  CHECK (release_reason IS NULL OR release_reason IN ('DISPATCH_REMOVED'));
ALTER TABLE dispatch.assignment ADD CONSTRAINT assignment_release_pair
  CHECK ((released_at IS NULL) = (release_reason IS NULL));
CREATE INDEX assignment_current_idx ON dispatch.assignment(tenant_id, run_id, driver_id, vehicle_id)
  WHERE released_at IS NULL;

COMMIT;
