-- DEMO AID ONLY (audit WEB-A-002): this repair removes the pickup and drop-off
-- signature requirement from one prototype leg so the trip can be walked without the
-- signature step. It is NOT a fix: the client/server order defect it worked around
-- (WEB-A-001) is fixed, so a signature-required leg works end to end. Do not treat a
-- repaired leg as evidence that signatures were verified.
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL ROLE kavaroutes_migration;
SELECT set_config('app.tenant_id','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',true);

-- Synthetic prototype repair only. The SOL-005 run was assigned before a
-- service-proof policy was attached, leaving the Driver client at pickup with
-- no legal next action. This small-business demo does not require signatures;
-- stricter organization/payer rules remain supported by other fixtures.
INSERT INTO execution.driver_leg_proof_rule(tenant_id,execution_id,policy_version,policy_digest,rule)
SELECT tenant_id,id,1,repeat('b',64),
  '{"pickupRequired":false,"dropoffRequired":false,"mobilitySecurementRequired":false,"allowedRoles":["RIDER","RIDER_UNABLE_TO_SIGN"],"unableReasons":["DECLINED","PHYSICALLY_UNABLE","NO_AUTHORIZED_SIGNER"],"noShowWaitMinutes":15,"noShowAllowed":false,"noShowAuthorizationReference":null}'::jsonb
FROM execution.leg_execution
WHERE tenant_id=platform.current_tenant_id()
  AND trip_leg_id='35000000-0000-4000-8000-000000000005'
  AND run_id='35000000-0000-4000-8000-000000000007'
ON CONFLICT DO NOTHING;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM execution.driver_leg_proof_rule p
    JOIN execution.leg_execution e ON e.tenant_id=p.tenant_id AND e.id=p.execution_id
    WHERE p.tenant_id=platform.current_tenant_id()
      AND e.trip_leg_id='35000000-0000-4000-8000-000000000005'
      AND e.run_id='35000000-0000-4000-8000-000000000007'
  ) THEN RAISE EXCEPTION 'DRIVER_WEB_PROOF_RULE_REPAIR_FAILED';
  END IF;
END $$;
COMMIT;
