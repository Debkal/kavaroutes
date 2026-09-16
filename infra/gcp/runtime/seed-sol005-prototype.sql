\set ON_ERROR_STOP on
BEGIN;
SET LOCAL ROLE kavaroutes_api;
SELECT set_config('app.tenant_id','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',true);
-- New unassigned future synthetic run; preserve the active SOL-004 shift and receipts.
INSERT INTO intake.trip_request(tenant_id,id,rider_id,service_date,service_timezone,local_service_time,resolved_service_at,resolved_utc_offset_seconds,ambiguity_policy,ambiguity_policy_version,lifecycle_reference)
SELECT tenant_id,'35000000-0000-4000-8000-000000000004',rider_id,service_date,service_timezone,'16:00','2026-09-14T23:00:00Z',-25200,'reject','civil-v1','draft'
FROM intake.trip_request WHERE tenant_id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' AND id='32000000-0000-4000-8000-000000000004' ON CONFLICT DO NOTHING;
INSERT INTO intake.trip_leg(tenant_id,id,trip_request_id,ordinal,origin_address_id,destination_address_id,planned_start_at,planned_end_at)
SELECT tenant_id,'35000000-0000-4000-8000-000000000005','35000000-0000-4000-8000-000000000004',1,origin_address_id,destination_address_id,'2026-09-14T23:00:00Z','2026-09-14T23:30:00Z'
FROM intake.trip_leg WHERE tenant_id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' AND id='32000000-0000-4000-8000-000000000005' ON CONFLICT DO NOTHING;
INSERT INTO dispatch.run(tenant_id,id,branch_id,service_date,service_timezone,planned_start_at,planned_end_at,lifecycle_reference)
SELECT tenant_id,'35000000-0000-4000-8000-000000000007',branch_id,service_date,service_timezone,'2026-09-14T22:45:00Z','2026-09-14T23:45:00Z','planned'
FROM dispatch.run WHERE tenant_id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' AND id='32000000-0000-4000-8000-000000000007' ON CONFLICT DO NOTHING;
INSERT INTO dispatch.run_leg(tenant_id,id,run_id,trip_leg_id,ordinal)
VALUES('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','35000000-0000-4000-8000-000000000008','35000000-0000-4000-8000-000000000007','35000000-0000-4000-8000-000000000005',1) ON CONFLICT DO NOTHING;
SET LOCAL ROLE kavaroutes_migration;
INSERT INTO dispatch.run_service_requirements VALUES('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','35000000-0000-4000-8000-000000000007',1,1,0,ARRAY[]::text[],ARRAY[]::text[]) ON CONFLICT DO NOTHING;
INSERT INTO fleet.vehicle_capacity VALUES('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','32000000-0000-4000-8000-000000000006',4,0) ON CONFLICT DO NOTHING;
COMMIT;
