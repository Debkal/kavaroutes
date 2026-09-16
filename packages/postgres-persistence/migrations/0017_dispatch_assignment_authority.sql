BEGIN;
SET LOCAL ROLE kavaroutes_migration;
CREATE TABLE dispatch.assignment_supersession (
 tenant_id uuid NOT NULL, prior_assignment_id uuid NOT NULL, replacement_assignment_id uuid NOT NULL,
 recorded_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(tenant_id,prior_assignment_id),
 UNIQUE(tenant_id,replacement_assignment_id), CHECK(prior_assignment_id<>replacement_assignment_id),
 FOREIGN KEY(tenant_id,prior_assignment_id) REFERENCES dispatch.assignment(tenant_id,id),
 FOREIGN KEY(tenant_id,replacement_assignment_id) REFERENCES dispatch.assignment(tenant_id,id)
);
CREATE TABLE dispatch.run_service_requirements (
 tenant_id uuid NOT NULL, run_id uuid NOT NULL, version bigint NOT NULL CHECK(version>0),
 seats_required integer NOT NULL CHECK(seats_required BETWEEN 1 AND 100),
 wheelchair_spaces_required integer NOT NULL CHECK(wheelchair_spaces_required BETWEEN 0 AND 20),
 driver_qualifications text[] NOT NULL, vehicle_qualifications text[] NOT NULL,
 PRIMARY KEY(tenant_id,run_id), FOREIGN KEY(tenant_id,run_id) REFERENCES dispatch.run(tenant_id,id)
);
CREATE TABLE fleet.vehicle_capacity (
 tenant_id uuid NOT NULL,vehicle_id uuid NOT NULL,seats integer NOT NULL CHECK(seats BETWEEN 1 AND 100),
 wheelchair_spaces integer NOT NULL CHECK(wheelchair_spaces BETWEEN 0 AND 20),
 PRIMARY KEY(tenant_id,vehicle_id),FOREIGN KEY(tenant_id,vehicle_id) REFERENCES fleet.vehicle(tenant_id,id)
);
DO $fn$
DECLARE tbl text; sch text;
BEGIN
 FOREACH tbl IN ARRAY ARRAY['assignment_supersession','run_service_requirements','vehicle_capacity'] LOOP
  sch:=CASE WHEN tbl='vehicle_capacity' THEN 'fleet' ELSE 'dispatch' END;
  EXECUTE format('ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY',sch,tbl);
  EXECUTE format('ALTER TABLE %I.%I FORCE ROW LEVEL SECURITY',sch,tbl);
  EXECUTE format('CREATE POLICY tenant_isolation ON %I.%I USING(tenant_id=platform.current_tenant_id()) WITH CHECK(tenant_id=platform.current_tenant_id())',sch,tbl);
  EXECUTE format('REVOKE ALL ON %I.%I FROM PUBLIC',sch,tbl);
  EXECUTE format('GRANT SELECT ON %I.%I TO kavaroutes_api',sch,tbl);
 END LOOP;
END $fn$;
GRANT INSERT ON dispatch.assignment_supersession TO kavaroutes_api;
CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON dispatch.assignment_supersession FOR EACH ROW EXECUTE FUNCTION execution.reject_driver_action_receipt_mutation();
CREATE FUNCTION dispatch.protect_superseded_assignment() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
 IF EXISTS(SELECT 1 FROM dispatch.assignment_supersession WHERE tenant_id=OLD.tenant_id AND prior_assignment_id=OLD.id) THEN
  RAISE EXCEPTION 'SUPERSEDED_ASSIGNMENT_IMMUTABLE' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $fn$;
CREATE TRIGGER protect_superseded_assignment BEFORE UPDATE ON dispatch.assignment
 FOR EACH ROW EXECUTE FUNCTION dispatch.protect_superseded_assignment();
-- The prior binding remains a historical record; every application read excludes superseded rows.
COMMIT;
