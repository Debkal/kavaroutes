BEGIN;
SET LOCAL ROLE kavaroutes_migration;

-- Client intake widens the retained facility record instead of adding a parallel
-- entity: the client IS the facility that the existing projection, capability and
-- facility_trip_scope rows already mean. Dispatch enters the four operator fields
-- that were missing; the address keeps living in intake.address, and a client
-- "route" is a trip linked through intake.facility_trip_scope.
ALTER TABLE intake.facility ADD COLUMN display_name text;
ALTER TABLE intake.facility ADD COLUMN entity_name text;
ALTER TABLE intake.facility ADD COLUMN phone text;
ALTER TABLE intake.facility ADD COLUMN notes text;

-- Bounded like every other operator-entered label, and nullable so the seeded
-- prototype rows stay valid without a backfill.
ALTER TABLE intake.facility ADD CONSTRAINT facility_display_name_length
  CHECK (display_name IS NULL OR length(display_name) BETWEEN 1 AND 200);
ALTER TABLE intake.facility ADD CONSTRAINT facility_entity_name_length
  CHECK (entity_name IS NULL OR length(entity_name) BETWEEN 1 AND 200);
ALTER TABLE intake.facility ADD CONSTRAINT facility_phone_length
  CHECK (phone IS NULL OR length(phone) BETWEEN 3 AND 40);
ALTER TABLE intake.facility ADD CONSTRAINT facility_notes_length
  CHECK (notes IS NULL OR length(notes) BETWEEN 1 AND 2000);

-- 0022 granted SELECT only, because the retired prototype only read the scope.
-- Planning a run for a client now writes the scope row in the same transaction as
-- the run it plans. INSERT only: removing a trip from a client stays a migration
-- action rather than a dispatch command.
GRANT INSERT ON intake.facility_trip_scope TO kavaroutes_api;

COMMIT;
