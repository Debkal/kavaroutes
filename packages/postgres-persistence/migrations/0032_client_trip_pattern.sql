BEGIN;
SET LOCAL ROLE kavaroutes_migration;

-- A client is not one address. Dispatch enters the trip pattern the client books:
-- one pickup, one or more drop-offs and whether the trip returns. The pickup stays
-- on intake.facility.address_id (the client primary address); drop-offs get their own
-- ordered rows so a plan can turn each one into a leg and a receipt can name them.
ALTER TABLE intake.facility ADD COLUMN trip_type text;
ALTER TABLE intake.facility ADD CONSTRAINT facility_trip_type_allowed
  CHECK (trip_type IS NULL OR trip_type IN ('ONE_WAY','ROUND_TRIP'));

CREATE TABLE intake.client_dropoff (
  tenant_id uuid NOT NULL,
  facility_id uuid NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal BETWEEN 1 AND 20),
  address_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, facility_id, ordinal),
  FOREIGN KEY (tenant_id, facility_id) REFERENCES intake.facility (tenant_id, id),
  FOREIGN KEY (tenant_id, address_id) REFERENCES intake.address (tenant_id, id)
);

ALTER TABLE intake.client_dropoff ENABLE ROW LEVEL SECURITY;
ALTER TABLE intake.client_dropoff FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON intake.client_dropoff
  USING (tenant_id = platform.current_tenant_id())
  WITH CHECK (tenant_id = platform.current_tenant_id());

-- Append-only from the api role: a drop-off list is replaced by inserting the next
-- pattern revision, never by editing history in place.
REVOKE ALL ON intake.client_dropoff FROM PUBLIC;
GRANT SELECT, INSERT ON intake.client_dropoff TO kavaroutes_api;

COMMIT;
