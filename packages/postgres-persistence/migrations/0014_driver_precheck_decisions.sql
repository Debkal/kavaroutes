BEGIN;

SET LOCAL ROLE kavaroutes_migration;

-- One shared version for shift events, rather than reusing client sequence numbers.
ALTER TABLE execution.shift_policy_snapshot ADD COLUMN aggregate_version bigint NOT NULL DEFAULT 1 CHECK (aggregate_version > 0);

CREATE TABLE execution.driver_precheck_decision (
  tenant_id uuid NOT NULL,
  shift_id uuid NOT NULL,
  vehicle_id uuid NOT NULL,
  policy_digest text NOT NULL CHECK (policy_digest ~ '^[a-f0-9]{64}$'),
  aggregate_version bigint NOT NULL CHECK (aggregate_version > 1),
  inspection_outcome text NOT NULL CHECK (inspection_outcome IN ('COMPLETED','SKIPPED','NOT_REQUIRED')),
  odometer_outcome text NOT NULL CHECK (odometer_outcome IN ('COMPLETED','SKIPPED','NOT_REQUIRED')),
  vehicle_state text NOT NULL CHECK (vehicle_state IN ('READY','BLOCKED_CRITICAL_DEFECT')),
  odometer integer CHECK (odometer BETWEEN 0 AND 9999999),
  fuel_level text CHECK (fuel_level IN ('EMPTY','QUARTER','HALF','THREE_QUARTERS','FULL')),
  inspection_definition_version text NOT NULL CHECK (inspection_definition_version = 'inspection-synthetic-v2'),
  answers jsonb NOT NULL CHECK (jsonb_typeof(answers) = 'array'),
  captured_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,shift_id),
  FOREIGN KEY (tenant_id,shift_id) REFERENCES execution.shift_policy_snapshot (tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,vehicle_id) REFERENCES fleet.vehicle (tenant_id,id) ON DELETE RESTRICT,
  CHECK ((odometer_outcome = 'COMPLETED') = (odometer IS NOT NULL AND fuel_level IS NOT NULL)),
  CHECK (odometer_outcome = 'COMPLETED' OR (odometer IS NULL AND fuel_level IS NULL)),
  CHECK ((inspection_outcome = 'COMPLETED' AND jsonb_array_length(answers) = 20)
    OR (inspection_outcome <> 'COMPLETED' AND jsonb_array_length(answers) = 0))
);

-- Bounded synthetic prototype photos. No new storage/provider activation.
CREATE TABLE execution.driver_precheck_photo (
  tenant_id uuid NOT NULL,
  shift_id uuid NOT NULL,
  digest text NOT NULL CHECK (digest ~ '^[a-f0-9]{64}$'),
  content bytea NOT NULL CHECK (octet_length(content) BETWEEN 100 AND 150000),
  PRIMARY KEY (tenant_id,shift_id,digest),
  FOREIGN KEY (tenant_id,shift_id) REFERENCES execution.driver_precheck_decision (tenant_id,shift_id) ON DELETE RESTRICT
);

ALTER TABLE execution.driver_precheck_decision ENABLE ROW LEVEL SECURITY;
ALTER TABLE execution.driver_precheck_decision FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON execution.driver_precheck_decision
  USING (tenant_id = platform.current_tenant_id()) WITH CHECK (tenant_id = platform.current_tenant_id());
ALTER TABLE execution.driver_precheck_photo ENABLE ROW LEVEL SECURITY;
ALTER TABLE execution.driver_precheck_photo FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON execution.driver_precheck_photo
  USING (tenant_id = platform.current_tenant_id()) WITH CHECK (tenant_id = platform.current_tenant_id());

CREATE TRIGGER driver_precheck_decision_immutable BEFORE UPDATE OR DELETE ON execution.driver_precheck_decision
FOR EACH ROW EXECUTE FUNCTION execution.reject_driver_action_receipt_mutation();
CREATE TRIGGER driver_precheck_photo_immutable BEFORE UPDATE OR DELETE ON execution.driver_precheck_photo
FOR EACH ROW EXECUTE FUNCTION execution.reject_driver_action_receipt_mutation();
REVOKE ALL ON execution.driver_precheck_decision,execution.driver_precheck_photo FROM PUBLIC;
GRANT SELECT,INSERT ON execution.driver_precheck_decision,execution.driver_precheck_photo TO kavaroutes_api;

RESET ROLE;

COMMIT;
