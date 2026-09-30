\set ON_ERROR_STOP on
BEGIN;
SET LOCAL ROLE kavaroutes_migration;
SELECT set_config('app.tenant_id','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',true);
-- Explicit administrator-owned synthetic scope; no address-based inference.
INSERT INTO intake.address(tenant_id,id,customer_label)
VALUES('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','38000000-0000-4000-8000-000000000001','Synthetic SOL008 facility address') ON CONFLICT DO NOTHING;
INSERT INTO intake.facility(tenant_id,id,address_id,synthetic_label)
VALUES('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','30000000-0000-4000-8000-000000000002','38000000-0000-4000-8000-000000000001','Synthetic SOL008 facility') ON CONFLICT DO NOTHING;
INSERT INTO intake.facility_trip_scope(tenant_id,facility_id,trip_id)
VALUES
('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','30000000-0000-4000-8000-000000000002','32000000-0000-4000-8000-000000000004'),
('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','30000000-0000-4000-8000-000000000002','35000000-0000-4000-8000-000000000004') ON CONFLICT DO NOTHING;
-- Replay must not silently reactivate a revoked grant.
DO $$ BEGIN
 IF (SELECT count(*) FROM intake.facility_trip_scope WHERE tenant_id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
 AND facility_id='30000000-0000-4000-8000-000000000002' AND active
 AND trip_id IN('32000000-0000-4000-8000-000000000004','35000000-0000-4000-8000-000000000004'))<>2
 THEN RAISE EXCEPTION 'SOL008_SCOPE_REQUIRES_REVIEW'; END IF;
END $$;
COMMIT;
