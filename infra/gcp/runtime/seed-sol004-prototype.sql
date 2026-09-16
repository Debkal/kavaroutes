\set ON_ERROR_STOP on
BEGIN;
SET LOCAL ROLE kavaroutes_api;
SELECT set_config('app.tenant_id','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',true);

-- One deterministic, synthetic-only Driver integration fixture. Never use this for PHI.
INSERT INTO platform.branch (tenant_id,id,organization_id,synthetic_label)
VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','32000000-0000-4000-8000-000000000001','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','Synthetic Driver Branch') ON CONFLICT DO NOTHING;
INSERT INTO intake.address (tenant_id,id,customer_label)
VALUES
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','32000000-0000-4000-8000-000000000002','Synthetic Community Center'),
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','32000000-0000-4000-8000-000000000003','Synthetic Public Library')
ON CONFLICT DO NOTHING;
INSERT INTO fleet.driver (tenant_id,id,synthetic_reference,workforce_relationship)
VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','30000000-0000-4000-8000-000000000001','Synthetic Driver 042','EMPLOYEE') ON CONFLICT DO NOTHING;
INSERT INTO fleet.vehicle (tenant_id,id,synthetic_reference)
VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','32000000-0000-4000-8000-000000000006','Synthetic SOL004 Van 14') ON CONFLICT DO NOTHING;
INSERT INTO intake.trip_request
  (tenant_id,id,rider_id,service_date,service_timezone,local_service_time,resolved_service_at,resolved_utc_offset_seconds,ambiguity_policy,ambiguity_policy_version,lifecycle_reference)
VALUES
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','32000000-0000-4000-8000-000000000004','11111111-1111-4111-8111-111111111112','2026-09-14','America/Los_Angeles','14:30','2026-09-14T21:30:00Z',-25200,'reject','civil-v1','draft')
ON CONFLICT DO NOTHING;
INSERT INTO intake.trip_leg
  (tenant_id,id,trip_request_id,ordinal,origin_address_id,destination_address_id,planned_start_at,planned_end_at)
VALUES
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','32000000-0000-4000-8000-000000000005','32000000-0000-4000-8000-000000000004',1,'32000000-0000-4000-8000-000000000002','32000000-0000-4000-8000-000000000003','2026-09-14T21:30:00Z','2026-09-14T22:15:00Z')
ON CONFLICT DO NOTHING;
INSERT INTO dispatch.run
  (tenant_id,id,branch_id,service_date,service_timezone,planned_start_at,planned_end_at,lifecycle_reference)
VALUES
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','32000000-0000-4000-8000-000000000007','32000000-0000-4000-8000-000000000001','2026-09-14','America/Los_Angeles','2026-09-14T21:15:00Z','2026-09-14T22:30:00Z','scheduled')
ON CONFLICT DO NOTHING;
INSERT INTO dispatch.run_leg (tenant_id,id,run_id,trip_leg_id,ordinal)
VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','32000000-0000-4000-8000-000000000008','32000000-0000-4000-8000-000000000007','32000000-0000-4000-8000-000000000005',1) ON CONFLICT DO NOTHING;
INSERT INTO dispatch.assignment (tenant_id,id,run_id,driver_id,vehicle_id,workforce_relationship)
VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','42000000-0000-4000-8000-000000000001','32000000-0000-4000-8000-000000000007','30000000-0000-4000-8000-000000000001','32000000-0000-4000-8000-000000000006','EMPLOYEE') ON CONFLICT DO NOTHING;



INSERT INTO execution.leg_execution(tenant_id,id,trip_leg_id,run_id,lifecycle_reference,occurred_at)
VALUES('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','32000000-0000-4000-8000-000000000009','32000000-0000-4000-8000-000000000005','32000000-0000-4000-8000-000000000007','dispatched',now()) ON CONFLICT DO NOTHING;
SET LOCAL ROLE kavaroutes_migration;
-- Explicit synthetic service proof rule, not a production payer default.
INSERT INTO execution.driver_leg_proof_rule(tenant_id,execution_id,policy_version,policy_digest,rule)
VALUES('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','32000000-0000-4000-8000-000000000009',1,repeat('a',64),'{"pickupRequired":true,"dropoffRequired":true,"mobilitySecurementRequired":false,"allowedRoles":["RIDER","RIDER_UNABLE_TO_SIGN"],"unableReasons":["PHYSICALLY_UNABLE"],"noShowWaitMinutes":15,"noShowAllowed":false,"noShowAuthorizationReference":null}'::jsonb) ON CONFLICT DO NOTHING;
COMMIT;
