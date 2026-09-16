BEGIN;
SET LOCAL ROLE kavaroutes_migration;
ALTER TABLE execution.shift_policy_snapshot ADD COLUMN collection_stopped boolean NOT NULL DEFAULT false;
ALTER TABLE execution.shift_policy_snapshot ADD COLUMN last_location_captured_at timestamptz;
ALTER TABLE execution.shift_policy_snapshot ADD COLUMN last_location_received_at timestamptz;
CREATE TABLE execution.driver_synthetic_location (
 tenant_id uuid NOT NULL,shift_id uuid NOT NULL,sample_id uuid NOT NULL,shift_generation uuid NOT NULL,
 sequence_number bigint NOT NULL CHECK(sequence_number>0),
 fixture text NOT NULL CHECK(fixture IN('AT_RETURN','OUTSIDE_RETURN','INACCURATE')),
 captured_at timestamptz NOT NULL,recorded_at timestamptz NOT NULL DEFAULT now(),expires_at timestamptz NOT NULL,
 PRIMARY KEY(tenant_id,sample_id),UNIQUE(tenant_id,shift_id,sequence_number),
 FOREIGN KEY(tenant_id,shift_id) REFERENCES execution.shift_policy_snapshot(tenant_id,id),CHECK(expires_at>recorded_at)
);
-- No real coordinates can enter this synthetic deployment lane.
CREATE TABLE execution.driver_return_configuration (
 tenant_id uuid NOT NULL,shift_id uuid NOT NULL,version bigint NOT NULL CHECK(version>0),
 fixture text NOT NULL CHECK(fixture='AT_RETURN'),maximum_age_seconds integer NOT NULL CHECK(maximum_age_seconds BETWEEN 1 AND 60),
 PRIMARY KEY(tenant_id,shift_id),FOREIGN KEY(tenant_id,shift_id) REFERENCES execution.shift_policy_snapshot(tenant_id,id)
);
CREATE TABLE execution.driver_shift_closure (
 tenant_id uuid NOT NULL,shift_id uuid NOT NULL,command_id uuid NOT NULL,aggregate_version bigint NOT NULL CHECK(aggregate_version>1),
 kind text NOT NULL CHECK(kind IN('SIGN_OFF','EMERGENCY_STOP','DISPATCH_OVERRIDE','RETURN_EXCEPTION')),
 return_result text NOT NULL CHECK(return_result IN('NOT_REQUIRED','PASS','OUTSIDE','STALE','INACCURATE','UNAVAILABLE','OVERRIDDEN')),
 reason_code text NOT NULL CHECK(reason_code IN('NORMAL_SIGN_OFF','SAFETY','PRIVACY','DEVICE_PROBLEM','OTHER','RETURN_EXCEPTION_REVIEWED')),
 evidence_reference uuid,actor_id uuid NOT NULL,recorded_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,command_id),FOREIGN KEY(tenant_id,shift_id) REFERENCES execution.shift_policy_snapshot(tenant_id,id),
 CHECK((kind='DISPATCH_OVERRIDE')=(evidence_reference IS NOT NULL))
);
CREATE UNIQUE INDEX driver_shift_single_end ON execution.driver_shift_closure(tenant_id,shift_id) WHERE kind IN('SIGN_OFF','DISPATCH_OVERRIDE');
DO $fn$
DECLARE tbl text;
BEGIN
 FOREACH tbl IN ARRAY ARRAY['driver_synthetic_location','driver_return_configuration','driver_shift_closure'] LOOP
  EXECUTE format('ALTER TABLE execution.%I ENABLE ROW LEVEL SECURITY',tbl);
  EXECUTE format('ALTER TABLE execution.%I FORCE ROW LEVEL SECURITY',tbl);
  EXECUTE format('CREATE POLICY tenant_isolation ON execution.%I USING(tenant_id=platform.current_tenant_id()) WITH CHECK(tenant_id=platform.current_tenant_id())',tbl);
  EXECUTE format('REVOKE ALL ON execution.%I FROM PUBLIC',tbl);
  EXECUTE format('GRANT SELECT ON execution.%I TO kavaroutes_api',tbl);
  IF tbl<>'driver_return_configuration' THEN EXECUTE format('GRANT INSERT ON execution.%I TO kavaroutes_api',tbl);END IF;
 END LOOP;
END $fn$;
CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON execution.driver_shift_closure FOR EACH ROW EXECUTE FUNCTION execution.reject_driver_action_receipt_mutation();
GRANT SELECT,DELETE ON execution.driver_synthetic_location TO kavaroutes_api,kavaroutes_outbox_consumer;
CREATE INDEX driver_synthetic_location_expiry ON execution.driver_synthetic_location(expires_at);
COMMIT;
