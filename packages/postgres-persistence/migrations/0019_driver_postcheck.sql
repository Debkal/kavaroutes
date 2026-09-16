BEGIN;
SET LOCAL ROLE kavaroutes_migration;
-- Separate immutable post-trip evidence; never overwrite the accepted pre-trip record.
CREATE TABLE execution.driver_postcheck_decision (LIKE execution.driver_precheck_decision INCLUDING ALL);
ALTER TABLE execution.driver_postcheck_decision
 ADD FOREIGN KEY(tenant_id,shift_id) REFERENCES execution.shift_policy_snapshot(tenant_id,id),
 ADD FOREIGN KEY(tenant_id,vehicle_id) REFERENCES fleet.vehicle(tenant_id,id);
CREATE TABLE execution.driver_postcheck_photo (LIKE execution.driver_precheck_photo INCLUDING ALL);
ALTER TABLE execution.driver_postcheck_photo ADD FOREIGN KEY(tenant_id,shift_id) REFERENCES execution.driver_postcheck_decision(tenant_id,shift_id);
DO $fn$
DECLARE tbl text;
BEGIN
 FOREACH tbl IN ARRAY ARRAY['driver_postcheck_decision','driver_postcheck_photo'] LOOP
  EXECUTE format('ALTER TABLE execution.%I ENABLE ROW LEVEL SECURITY',tbl);
  EXECUTE format('ALTER TABLE execution.%I FORCE ROW LEVEL SECURITY',tbl);
  EXECUTE format('CREATE POLICY tenant_isolation ON execution.%I USING(tenant_id=platform.current_tenant_id()) WITH CHECK(tenant_id=platform.current_tenant_id())',tbl);
  EXECUTE format('CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON execution.%I FOR EACH ROW EXECUTE FUNCTION execution.reject_driver_action_receipt_mutation()',tbl);
  EXECUTE format('REVOKE ALL ON execution.%I FROM PUBLIC',tbl);
  EXECUTE format('GRANT SELECT,INSERT ON execution.%I TO kavaroutes_api',tbl);
 END LOOP;
END $fn$;
COMMIT;
