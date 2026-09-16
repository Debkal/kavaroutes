\set ON_ERROR_STOP on
BEGIN;
SET LOCAL ROLE kavaroutes_api;
SELECT set_config('app.tenant_id','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',true);
-- Administrative retirement of the exact completed infrastructure-test fixture.
-- This is not a driver sign-off, return-location proof, or historical-version backfill.
DO $review$
DECLARE prior execution.shift_policy_snapshot%ROWTYPE;
BEGIN
  SELECT * INTO STRICT prior FROM execution.shift_policy_snapshot
  WHERE tenant_id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' AND id='ff8cc83f-baba-47bf-a636-11132bac1262' FOR UPDATE;
  IF prior.assignment_id<>'40000000-0000-4000-8000-000000000001' OR prior.driver_id<>'30000000-0000-4000-8000-000000000001' OR prior.pinned_assignment_version IS NOT NULL THEN
    RAISE EXCEPTION 'LEGACY_FIXTURE_IDENTITY_CHANGED';
  END IF;
  IF EXISTS(SELECT 1 FROM execution.driver_action_receipt WHERE tenant_id=prior.tenant_id AND shift_id=prior.id)
    OR EXISTS(SELECT 1 FROM execution.driver_precheck_decision WHERE tenant_id=prior.tenant_id AND shift_id=prior.id)
    OR EXISTS(SELECT 1 FROM execution.leg_execution e JOIN dispatch.assignment a ON a.tenant_id=e.tenant_id AND a.run_id=e.run_id WHERE a.tenant_id=prior.tenant_id AND a.id=prior.assignment_id) THEN
    RAISE EXCEPTION 'LEGACY_FIXTURE_HAS_EXECUTION_REVIEW_REQUIRED';
  END IF;
  IF prior.lifecycle='SHIFT_ENDED' THEN RETURN; END IF;
  UPDATE execution.shift_policy_snapshot SET lifecycle='SHIFT_ENDED' WHERE tenant_id=prior.tenant_id AND id=prior.id;
  INSERT INTO audit.event(tenant_id,id,aggregate_kind,aggregate_id,aggregate_version,action_reference,actor_reference,metadata)
  VALUES(prior.tenant_id,'42000000-0000-4000-8000-000000000099','driver-shift',prior.id,prior.aggregate_version,
    'synthetic.fixture.retired_after_schema_review','cloud-worker.sol004','{"reason":"LEGACY_SYNTHETIC_SHIFT_WITHOUT_EXECUTION","driverSignoff":false,"historicalVersionBackfilled":false}'::jsonb);
END $review$;
COMMIT;
