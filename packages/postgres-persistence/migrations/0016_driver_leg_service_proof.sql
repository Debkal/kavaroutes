BEGIN;
SET LOCAL ROLE kavaroutes_migration;
-- Explicit administrator/assignment-resolved rules; no tenant or tier fallback.
CREATE TABLE execution.driver_leg_proof_rule (
  tenant_id uuid NOT NULL, execution_id uuid NOT NULL, policy_version bigint NOT NULL CHECK(policy_version>0),
  policy_digest text NOT NULL CHECK(policy_digest ~ '^[a-f0-9]{64}$'),
  rule jsonb NOT NULL CHECK(jsonb_typeof(rule)='object'), PRIMARY KEY(tenant_id,execution_id),
  FOREIGN KEY(tenant_id,execution_id) REFERENCES execution.leg_execution(tenant_id,id)
);
CREATE TABLE execution.driver_leg_service_control (
  tenant_id uuid NOT NULL, execution_id uuid NOT NULL, rider_verified boolean NOT NULL DEFAULT false,
  boarding_secure boolean NOT NULL DEFAULT false, safely_unloaded boolean NOT NULL DEFAULT false,
  incident_open boolean NOT NULL DEFAULT false, PRIMARY KEY(tenant_id,execution_id),
  pickup_arrived_at timestamptz,
  FOREIGN KEY(tenant_id,execution_id) REFERENCES execution.leg_execution(tenant_id,id)
);
CREATE TABLE execution.driver_service_proof (
  tenant_id uuid NOT NULL, evidence_id uuid NOT NULL, shift_id uuid NOT NULL, execution_id uuid NOT NULL,
  event text NOT NULL CHECK(event IN ('PICKUP_ATTESTATION','DROPOFF_ATTESTATION')),
  policy_version bigint NOT NULL CHECK(policy_version>0), policy_digest text NOT NULL,
  digest text NOT NULL CHECK(digest ~ '^[a-f0-9]{64}$'), stroke_digest text CHECK(stroke_digest ~ '^[a-f0-9]{64}$'),
  signer_role text NOT NULL, unsigned_payload jsonb NOT NULL, evidence_record_id uuid NOT NULL,
  revision_number bigint NOT NULL CHECK(revision_number>0), recorded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id,evidence_id), UNIQUE(tenant_id,digest), UNIQUE(tenant_id,stroke_digest),
  FOREIGN KEY(tenant_id,evidence_id) REFERENCES execution.evidence_revision(tenant_id,id),
  FOREIGN KEY(tenant_id,evidence_record_id) REFERENCES execution.evidence_record(tenant_id,id),
  FOREIGN KEY(tenant_id,shift_id) REFERENCES execution.shift_policy_snapshot(tenant_id,id),
  FOREIGN KEY(tenant_id,execution_id) REFERENCES execution.leg_execution(tenant_id,id)
);
CREATE TABLE execution.driver_proof_supersession (
  tenant_id uuid NOT NULL, evidence_id uuid NOT NULL, supersedes_evidence_id uuid NOT NULL,
  PRIMARY KEY(tenant_id,evidence_id), UNIQUE(tenant_id,supersedes_evidence_id),
  FOREIGN KEY(tenant_id,evidence_id) REFERENCES execution.driver_service_proof(tenant_id,evidence_id),
  FOREIGN KEY(tenant_id,supersedes_evidence_id) REFERENCES execution.driver_service_proof(tenant_id,evidence_id),
  CHECK(evidence_id<>supersedes_evidence_id)
);
CREATE TABLE execution.driver_leg_exception (
  tenant_id uuid NOT NULL, action_id uuid NOT NULL, shift_id uuid NOT NULL, execution_id uuid NOT NULL,
  kind text NOT NULL CHECK(kind IN ('INCIDENT','RIDER_NO_SHOW','CANCEL_REQUEST')),
  documentation jsonb NOT NULL, recorded_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(tenant_id,action_id),
  FOREIGN KEY(tenant_id,shift_id) REFERENCES execution.shift_policy_snapshot(tenant_id,id),
  FOREIGN KEY(tenant_id,execution_id) REFERENCES execution.leg_execution(tenant_id,id)
);
CREATE TABLE execution.driver_recovery_case (
  tenant_id uuid NOT NULL,action_id uuid NOT NULL,execution_id uuid NOT NULL,
  state text NOT NULL DEFAULT 'OPEN' CHECK(state IN ('OPEN','RESOLVED')),PRIMARY KEY(tenant_id,action_id),
  FOREIGN KEY(tenant_id,action_id) REFERENCES execution.driver_leg_exception(tenant_id,action_id),
  FOREIGN KEY(tenant_id,execution_id) REFERENCES execution.leg_execution(tenant_id,id)
);
DO $fn$
DECLARE name text;
BEGIN
  FOREACH name IN ARRAY ARRAY['driver_leg_proof_rule','driver_leg_service_control','driver_service_proof','driver_proof_supersession','driver_leg_exception','driver_recovery_case'] LOOP
    EXECUTE format('ALTER TABLE execution.%I ENABLE ROW LEVEL SECURITY',name);
    EXECUTE format('ALTER TABLE execution.%I FORCE ROW LEVEL SECURITY',name);
    EXECUTE format('CREATE POLICY tenant_isolation ON execution.%I USING (tenant_id=platform.current_tenant_id()) WITH CHECK (tenant_id=platform.current_tenant_id())',name);
    EXECUTE format('REVOKE ALL ON execution.%I FROM PUBLIC',name);
    EXECUTE format('GRANT SELECT ON execution.%I TO kavaroutes_api',name);
    IF name <> 'driver_leg_service_control' THEN
      EXECUTE format('CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON execution.%I FOR EACH ROW EXECUTE FUNCTION execution.reject_driver_action_receipt_mutation()',name);
    END IF;
  END LOOP;
END $fn$;
GRANT INSERT,UPDATE ON execution.driver_leg_service_control TO kavaroutes_api;
GRANT INSERT ON execution.driver_service_proof,execution.driver_proof_supersession,execution.driver_leg_exception,execution.driver_recovery_case TO kavaroutes_api;
RESET ROLE;
COMMIT;
