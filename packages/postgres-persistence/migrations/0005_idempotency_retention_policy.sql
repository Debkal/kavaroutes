BEGIN;

SET LOCAL timezone = 'UTC';
SET LOCAL ROLE kavaroutes_migration;

ALTER TABLE platform.idempotency_record
  DROP CONSTRAINT idempotency_record_expiry_check,
  ADD CONSTRAINT idempotency_record_expiry_check
    CHECK (expires_at >= created_at + interval '24 hours');

SELECT platform.assert_tenant_boundaries();

RESET ROLE;
COMMIT;
