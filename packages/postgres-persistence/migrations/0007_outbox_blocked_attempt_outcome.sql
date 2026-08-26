BEGIN;

SET LOCAL ROLE kavaroutes_migration;

ALTER TABLE outbox.delivery_attempt
  DROP CONSTRAINT delivery_attempt_outcome_check,
  ADD CONSTRAINT delivery_attempt_outcome_check
    CHECK (outcome IN ('LEASED','COMMITTED','ROLLED_BACK','RETRY_SCHEDULED','BLOCKED','DEAD_LETTERED'));

SELECT platform.assert_tenant_boundaries();

COMMIT;
