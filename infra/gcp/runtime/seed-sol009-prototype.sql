\set ON_ERROR_STOP on
BEGIN;
SET LOCAL ROLE kavaroutes_migration;
SELECT set_config('app.tenant_id','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',true);
-- New planning-only synthetic fixture. No assignment, shift, completion or receipt
-- is manufactured. Re-running deliberately fails rather than changing old evidence.
DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM dispatch.run WHERE tenant_id=platform.current_tenant_id()
 AND id='39000000-0000-4000-8000-000000000007') THEN
  RAISE EXCEPTION 'SOL009_FIXTURE_EXISTS_RESUME_CLIENT_WORKFLOW';
 END IF;
 IF EXISTS (SELECT 1 FROM execution.shift_policy_snapshot WHERE tenant_id=platform.current_tenant_id()
 AND driver_id='30000000-0000-4000-8000-000000000001' AND lifecycle<>'SHIFT_ENDED') THEN
  RAISE EXCEPTION 'EXISTING_DRIVER_SHIFT_REQUIRES_REAL_CLOSURE';
 END IF;
END $$;

INSERT INTO intake.trip_request
 (tenant_id,id,rider_id,service_date,service_timezone,local_service_time,resolved_service_at,
 resolved_utc_offset_seconds,ambiguity_policy,ambiguity_policy_version,lifecycle_reference)
SELECT platform.current_tenant_id(),trip_id,'11111111-1111-4111-8111-111111111112',
 '2026-09-15','America/Los_Angeles',local_time,scheduled_at,-25200,'reject','civil-v1','draft'
FROM (VALUES
 ('39000000-0000-4000-8000-000000000004'::uuid,'16:05'::time,'2026-09-15T23:05:00Z'::timestamptz),
 ('39000000-0000-4000-8000-000000000014'::uuid,'16:25'::time,'2026-09-15T23:25:00Z'::timestamptz)
) AS trips(trip_id,local_time,scheduled_at);

INSERT INTO intake.trip_leg
 (tenant_id,id,trip_request_id,ordinal,origin_address_id,destination_address_id,planned_start_at,planned_end_at)
SELECT platform.current_tenant_id(),leg_id,trip_id,1,
 '32000000-0000-4000-8000-000000000002','32000000-0000-4000-8000-000000000003',starts,starts+interval '15 minutes'
FROM (VALUES
 ('39000000-0000-4000-8000-000000000005'::uuid,'39000000-0000-4000-8000-000000000004'::uuid,'2026-09-15T23:05:00Z'::timestamptz),
 ('39000000-0000-4000-8000-000000000015'::uuid,'39000000-0000-4000-8000-000000000014'::uuid,'2026-09-15T23:25:00Z'::timestamptz)
) AS legs(leg_id,trip_id,starts);

INSERT INTO dispatch.run
 (tenant_id,id,branch_id,service_date,service_timezone,planned_start_at,planned_end_at,lifecycle_reference)
VALUES (platform.current_tenant_id(),'39000000-0000-4000-8000-000000000007',
 '32000000-0000-4000-8000-000000000001','2026-09-15','America/Los_Angeles',
 '2026-09-15T23:00:00Z','2026-09-16T00:00:00Z','planned');
INSERT INTO dispatch.run_leg(tenant_id,id,run_id,trip_leg_id,ordinal) VALUES
 (platform.current_tenant_id(),'39000000-0000-4000-8000-000000000008','39000000-0000-4000-8000-000000000007','39000000-0000-4000-8000-000000000005',1),
 (platform.current_tenant_id(),'39000000-0000-4000-8000-000000000018','39000000-0000-4000-8000-000000000007','39000000-0000-4000-8000-000000000015',2);
INSERT INTO dispatch.run_service_requirements VALUES
 (platform.current_tenant_id(),'39000000-0000-4000-8000-000000000007',1,2,0,ARRAY[]::text[],ARRAY[]::text[]);

-- Planned execution identities allow explicit synthetic proof policy before the
-- real assignment command transitions both legs to dispatched.
INSERT INTO execution.leg_execution(tenant_id,id,trip_leg_id,run_id,lifecycle_reference,occurred_at) VALUES
 (platform.current_tenant_id(),'39000000-0000-4000-8000-000000000009','39000000-0000-4000-8000-000000000005','39000000-0000-4000-8000-000000000007','planned',now()),
 (platform.current_tenant_id(),'39000000-0000-4000-8000-000000000019','39000000-0000-4000-8000-000000000015','39000000-0000-4000-8000-000000000007','planned',now());
INSERT INTO execution.driver_leg_proof_rule(tenant_id,execution_id,policy_version,policy_digest,rule)
SELECT tenant_id,id,1,repeat('a',64),
 '{"pickupRequired":true,"dropoffRequired":true,"mobilitySecurementRequired":false,"allowedRoles":["RIDER","RIDER_UNABLE_TO_SIGN"],"unableReasons":["PHYSICALLY_UNABLE"],"noShowWaitMinutes":15,"noShowAllowed":false,"noShowAuthorizationReference":null}'::jsonb
FROM execution.leg_execution WHERE tenant_id=platform.current_tenant_id() AND run_id='39000000-0000-4000-8000-000000000007';

-- Flexible public-place synthetic visits permit a meaningful two-leg reorder.
-- Ten-second travel is a fixture, not a Google Maps result or ETA claim.
WITH nodes AS (
 SELECT jsonb_agg(jsonb_build_object('id',node_id,'legId',leg_id,'kind',kind,'locked',false,
 'earliest',extract(epoch FROM timestamptz '2026-09-15T23:00:00Z')*1000,
 'latest',extract(epoch FROM timestamptz '2026-09-16T00:00:00Z')*1000,'serviceSeconds',5) ORDER BY ordinal) AS value
 FROM (VALUES
 ('39000000-0000-4000-8000-000000000021','39000000-0000-4000-8000-000000000005','PICKUP',1),
 ('39000000-0000-4000-8000-000000000022','39000000-0000-4000-8000-000000000005','DROPOFF',2),
 ('39000000-0000-4000-8000-000000000023','39000000-0000-4000-8000-000000000015','PICKUP',3),
 ('39000000-0000-4000-8000-000000000024','39000000-0000-4000-8000-000000000015','DROPOFF',4)
 ) AS n(node_id,leg_id,kind,ordinal)
), travel AS (
 SELECT jsonb_object_agg(a.id||':'||(b.value->>'id'),10) AS value
 FROM nodes, LATERAL (SELECT value->>'id' AS id FROM jsonb_array_elements(nodes.value)
 UNION ALL SELECT '39000000-0000-4000-8000-000000000020') a,
 LATERAL jsonb_array_elements(nodes.value) b
)
INSERT INTO dispatch.route_planning_facts(tenant_id,run_id,version,nodes,feasibility)
SELECT platform.current_tenant_id(),'39000000-0000-4000-8000-000000000007',1,nodes.value,
 jsonb_build_object('startAt',extract(epoch FROM timestamptz '2026-09-15T23:00:00Z')*1000,
 'returnBy',extract(epoch FROM timestamptz '2026-09-16T00:00:00Z')*1000,
 'startNode','39000000-0000-4000-8000-000000000020','requiredReturnNode',null,
 'seats',4,'wheelchairSpaces',0,'legs',
 '[{"legId":"39000000-0000-4000-8000-000000000005","seats":1,"wheelchairSpaces":0,"maximumRideSeconds":600},{"legId":"39000000-0000-4000-8000-000000000015","seats":1,"wheelchairSpaces":0,"maximumRideSeconds":600}]'::jsonb,
 'travelSeconds',travel.value)
FROM nodes,travel;

INSERT INTO intake.facility_trip_scope(tenant_id,facility_id,trip_id) VALUES
 (platform.current_tenant_id(),'30000000-0000-4000-8000-000000000002','39000000-0000-4000-8000-000000000004'),
 (platform.current_tenant_id(),'30000000-0000-4000-8000-000000000002','39000000-0000-4000-8000-000000000014');
COMMIT;
