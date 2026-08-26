BEGIN;

SET LOCAL timezone = 'UTC';
SET LOCAL ROLE kavaroutes_migration;

ALTER TABLE platform.idempotency_record
  DROP CONSTRAINT idempotency_record_tenant_id_operation_key_key;

ALTER TABLE platform.idempotency_record
  ADD COLUMN actor_reference text NOT NULL DEFAULT 'legacy-synthetic-actor',
  ADD COLUMN operation_id text NOT NULL DEFAULT 'legacy-operation',
  ADD COLUMN state text NOT NULL DEFAULT 'COMMITTED',
  ADD COLUMN response_status integer NOT NULL DEFAULT 200,
  ADD COLUMN response_body jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN response_headers jsonb NOT NULL DEFAULT '{}'::jsonb;

UPDATE platform.idempotency_record
SET expires_at = created_at + interval '24 hours'
WHERE expires_at IS NULL;

ALTER TABLE platform.idempotency_record
  ALTER COLUMN expires_at SET DEFAULT (now() + interval '24 hours'),
  ALTER COLUMN expires_at SET NOT NULL,
  ADD CONSTRAINT idempotency_record_state_check CHECK (state IN ('IN_PROGRESS', 'COMMITTED')),
  ADD CONSTRAINT idempotency_record_response_status_check CHECK (response_status BETWEEN 100 AND 599),
  ADD CONSTRAINT idempotency_record_expiry_check CHECK (expires_at >= created_at),
  ADD CONSTRAINT idempotency_record_scoped_key_unique UNIQUE (tenant_id, actor_reference, operation_id, operation_key);

CREATE INDEX idempotency_record_expiry_idx ON platform.idempotency_record (tenant_id, expires_at);

SELECT platform.assert_tenant_boundaries();

RESET ROLE;
COMMIT;
