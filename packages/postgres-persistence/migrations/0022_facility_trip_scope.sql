BEGIN;
SET LOCAL ROLE kavaroutes_migration;
-- Explicit coordination grants, never inferred from a shared address or browser filter.
-- Administration/import approval owns grants; the runtime cannot grant itself access.
CREATE TABLE intake.facility_trip_scope (
 tenant_id uuid NOT NULL,facility_id uuid NOT NULL,trip_id uuid NOT NULL,
 active boolean NOT NULL DEFAULT true,version bigint NOT NULL DEFAULT 1 CHECK(version>0),
 PRIMARY KEY(tenant_id,facility_id,trip_id),
 FOREIGN KEY(tenant_id,facility_id) REFERENCES intake.facility(tenant_id,id),
 FOREIGN KEY(tenant_id,trip_id) REFERENCES intake.trip_request(tenant_id,id)
);
ALTER TABLE intake.facility_trip_scope ENABLE ROW LEVEL SECURITY;
ALTER TABLE intake.facility_trip_scope FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON intake.facility_trip_scope USING(tenant_id=platform.current_tenant_id()) WITH CHECK(tenant_id=platform.current_tenant_id());
REVOKE ALL ON intake.facility_trip_scope FROM PUBLIC;
GRANT SELECT ON intake.facility_trip_scope TO kavaroutes_api;
CREATE INDEX facility_trip_active ON intake.facility_trip_scope(tenant_id,facility_id,trip_id) WHERE active;
COMMIT;
