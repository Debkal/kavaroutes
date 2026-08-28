BEGIN;

SET LOCAL ROLE kavaroutes_migration;

ALTER TABLE platform.organization
  ADD COLUMN commercial_tier text NOT NULL DEFAULT 'ENTERPRISE'
  CHECK (commercial_tier IN ('SMALL_BUSINESS','ENTERPRISE'));

ALTER TABLE fleet.driver
  ADD COLUMN workforce_relationship text NOT NULL DEFAULT 'EMPLOYEE'
  CHECK (workforce_relationship IN ('OWNER_OPERATOR','EMPLOYEE','CONTRACTOR'));

ALTER TABLE dispatch.assignment
  ADD COLUMN workforce_relationship text
  CHECK (workforce_relationship IS NULL OR workforce_relationship IN ('OWNER_OPERATOR','EMPLOYEE','CONTRACTOR'));

CREATE TABLE platform.driver_control_policy (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL,
  organization_id uuid NOT NULL,
  scope_kind text NOT NULL CHECK (scope_kind IN ('ORGANIZATION','BRANCH','FLEET','ROLE')),
  scope_reference uuid,
  policy_version bigint NOT NULL CHECK (policy_version > 0),
  controls jsonb NOT NULL CHECK (jsonb_typeof(controls) = 'object'),
  locks jsonb NOT NULL CHECK (jsonb_typeof(locks) = 'object'),
  lifecycle text NOT NULL DEFAULT 'ACTIVE' CHECK (lifecycle IN ('ACTIVE','SUPERSEDED','RETIRED')),
  reason_code text NOT NULL CHECK (reason_code IN ('MIGRATED_ENTERPRISE_STRICT','OWNER_ENABLED_STRICT_PRESET','OPERATING_POLICY_CHANGED','EXTERNAL_REQUIREMENT_CHANGED')),
  aggregate_version bigint NOT NULL DEFAULT 1 CHECK (aggregate_version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid NOT NULL,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, organization_id) REFERENCES platform.organization (tenant_id, id),
  CHECK ((scope_kind = 'ORGANIZATION' AND scope_reference IS NULL) OR (scope_kind <> 'ORGANIZATION' AND scope_reference IS NOT NULL))
);

CREATE UNIQUE INDEX driver_control_policy_scope_version_idx
  ON platform.driver_control_policy (tenant_id, organization_id, scope_kind, coalesce(scope_reference, '00000000-0000-0000-0000-000000000000'::uuid), policy_version);

CREATE UNIQUE INDEX driver_control_policy_active_scope_idx
  ON platform.driver_control_policy (tenant_id, organization_id, scope_kind, coalesce(scope_reference, '00000000-0000-0000-0000-000000000000'::uuid))
  WHERE lifecycle = 'ACTIVE';

CREATE TABLE platform.driver_external_floor_reference (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL,
  organization_id uuid NOT NULL,
  floor_kind text NOT NULL CHECK (floor_kind IN ('JURISDICTION','PAYER','BROKER','INSURER','VEHICLE','ACCESSIBILITY','PRIVACY_SECURITY')),
  safe_reference text NOT NULL CHECK (safe_reference ~ '^[A-Z][A-Z0-9_.-]{2,95}$'),
  controls jsonb NOT NULL CHECK (jsonb_typeof(controls) = 'object'),
  policy_version bigint NOT NULL CHECK (policy_version > 0),
  effective_from timestamptz NOT NULL,
  effective_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, organization_id, floor_kind, safe_reference, policy_version),
  FOREIGN KEY (tenant_id, organization_id) REFERENCES platform.organization (tenant_id, id),
  CHECK (effective_until IS NULL OR effective_until > effective_from)
);

CREATE TABLE execution.shift_policy_snapshot (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL,
  assignment_id uuid NOT NULL,
  driver_id uuid NOT NULL,
  shift_generation uuid NOT NULL,
  policy_version bigint NOT NULL CHECK (policy_version > 0),
  policy_digest text NOT NULL CHECK (policy_digest ~ '^[a-f0-9]{64}$'),
  effective_policy jsonb NOT NULL CHECK (jsonb_typeof(effective_policy) = 'object'),
  lifecycle text NOT NULL DEFAULT 'ACTIVE' CHECK (lifecycle IN ('ACTIVE','INVALIDATE_REVIEW','SHIFT_ENDED')),
  pinned_at timestamptz NOT NULL DEFAULT now(),
  invalidated_at timestamptz,
  invalidation_reason_code text CHECK (invalidation_reason_code IS NULL OR invalidation_reason_code IN ('CRITICAL_EXTERNAL_RULE','TENANT_DEPROVISIONED','ASSIGNMENT_REVOKED')),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, assignment_id, shift_generation),
  FOREIGN KEY (tenant_id, assignment_id) REFERENCES dispatch.assignment (tenant_id, id),
  FOREIGN KEY (tenant_id, driver_id) REFERENCES fleet.driver (tenant_id, id),
  CHECK ((lifecycle = 'INVALIDATE_REVIEW') = (invalidated_at IS NOT NULL AND invalidation_reason_code IS NOT NULL))
);

CREATE INDEX driver_external_floor_effective_idx ON platform.driver_external_floor_reference (tenant_id, organization_id, effective_from, effective_until);
CREATE INDEX shift_policy_snapshot_driver_idx ON execution.shift_policy_snapshot (tenant_id, driver_id, pinned_at DESC);
CREATE INDEX shift_policy_snapshot_active_idx ON execution.shift_policy_snapshot (tenant_id, assignment_id, lifecycle) WHERE lifecycle <> 'SHIFT_ENDED';

CREATE OR REPLACE FUNCTION execution.reject_shift_policy_snapshot_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'SHIFT_POLICY_SNAPSHOT_IMMUTABLE' USING ERRCODE = '23514'; END IF;
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.id IS DISTINCT FROM OLD.id OR NEW.assignment_id IS DISTINCT FROM OLD.assignment_id
    OR NEW.driver_id IS DISTINCT FROM OLD.driver_id OR NEW.shift_generation IS DISTINCT FROM OLD.shift_generation
    OR NEW.policy_version IS DISTINCT FROM OLD.policy_version OR NEW.policy_digest IS DISTINCT FROM OLD.policy_digest
    OR NEW.effective_policy IS DISTINCT FROM OLD.effective_policy OR NEW.pinned_at IS DISTINCT FROM OLD.pinned_at THEN
    RAISE EXCEPTION 'SHIFT_POLICY_SNAPSHOT_IMMUTABLE' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$function$;

CREATE TRIGGER shift_policy_snapshot_immutable
BEFORE UPDATE OR DELETE ON execution.shift_policy_snapshot
FOR EACH ROW EXECUTE FUNCTION execution.reject_shift_policy_snapshot_mutation();

DO $rls$
DECLARE item record;
BEGIN
  FOR item IN SELECT * FROM (VALUES ('platform','driver_control_policy'), ('platform','driver_external_floor_reference'), ('execution','shift_policy_snapshot')) AS values_to_secure(schema_name, table_name)
  LOOP
    EXECUTE format('ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY', item.schema_name, item.table_name);
    EXECUTE format('ALTER TABLE %I.%I FORCE ROW LEVEL SECURITY', item.schema_name, item.table_name);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I.%I USING (tenant_id = platform.current_tenant_id()) WITH CHECK (tenant_id = platform.current_tenant_id())', item.schema_name, item.table_name);
  END LOOP;
END
$rls$;

INSERT INTO platform.driver_control_policy (tenant_id, id, organization_id, scope_kind, scope_reference, policy_version, controls, locks, reason_code, created_by)
SELECT tenant_id, gen_random_uuid(), id, 'ORGANIZATION', NULL, 1,
  '{"preInspection":"REQUIRED","postInspection":"REQUIRED","startOdometer":"REQUIRED","endOdometer":"REQUIRED","returnVerification":"REQUIRED_WITH_AUDITED_OVERRIDE","routeChange":"DISPATCH_APPROVAL_REQUIRED"}'::jsonb,
  '{"preInspection":true,"postInspection":true,"startOdometer":true,"endOdometer":true,"returnVerification":true,"routeChange":true}'::jsonb,
  'MIGRATED_ENTERPRISE_STRICT', id
FROM platform.organization;

CREATE OR REPLACE FUNCTION platform.seed_enterprise_driver_control_policy()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  INSERT INTO platform.driver_control_policy (
    tenant_id, id, organization_id, scope_kind, scope_reference, policy_version,
    controls, locks, reason_code, created_by
  ) VALUES (
    NEW.tenant_id, gen_random_uuid(), NEW.id, 'ORGANIZATION', NULL, 1,
    '{"preInspection":"REQUIRED","postInspection":"REQUIRED","startOdometer":"REQUIRED","endOdometer":"REQUIRED","returnVerification":"REQUIRED_WITH_AUDITED_OVERRIDE","routeChange":"DISPATCH_APPROVAL_REQUIRED"}'::jsonb,
    '{"preInspection":true,"postInspection":true,"startOdometer":true,"endOdometer":true,"returnVerification":true,"routeChange":true}'::jsonb,
    'MIGRATED_ENTERPRISE_STRICT', NEW.id
  );
  RETURN NEW;
END
$function$;

CREATE TRIGGER organization_seed_enterprise_driver_control_policy
AFTER INSERT ON platform.organization
FOR EACH ROW EXECUTE FUNCTION platform.seed_enterprise_driver_control_policy();

SELECT platform.assert_tenant_boundaries();

RESET ROLE;

REVOKE ALL ON platform.driver_control_policy, platform.driver_external_floor_reference, execution.shift_policy_snapshot FROM PUBLIC;
GRANT SELECT ON platform.driver_control_policy, platform.driver_external_floor_reference, execution.shift_policy_snapshot TO kavaroutes_api, kavaroutes_worker;
GRANT INSERT, UPDATE ON platform.driver_control_policy, platform.driver_external_floor_reference TO kavaroutes_api;
GRANT INSERT, UPDATE ON execution.shift_policy_snapshot TO kavaroutes_api, kavaroutes_worker;

COMMIT;
