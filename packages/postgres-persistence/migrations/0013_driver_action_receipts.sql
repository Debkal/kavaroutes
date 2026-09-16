BEGIN;

SET LOCAL ROLE kavaroutes_migration;

-- Receipts are committed in the same transaction as their domain effect.
-- Raw signatures, notes, coordinates and command payloads do not belong here.
CREATE TABLE execution.driver_action_receipt (
  tenant_id uuid NOT NULL,
  client_action_id uuid NOT NULL,
  shift_id uuid NOT NULL,
  sequence_number bigint NOT NULL CHECK (sequence_number > 0),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 16 AND 128 AND idempotency_key ~ '^[A-Za-z0-9_-]+$'),
  command_fingerprint text NOT NULL CHECK (command_fingerprint ~ '^[a-f0-9]{64}$'),
  command_reference text NOT NULL CHECK (command_reference ~ '^[A-Z][A-Z0-9_]{2,63}$'),
  resource_reference uuid NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('APPLIED','REJECTED')),
  resource_version bigint CHECK (resource_version > 0),
  reason_code text CHECK (reason_code ~ '^[A-Z][A-Z0-9_]{2,63}$'),
  captured_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, client_action_id),
  UNIQUE (tenant_id, shift_id, sequence_number),
  UNIQUE (tenant_id, shift_id, idempotency_key),
  FOREIGN KEY (tenant_id, shift_id) REFERENCES execution.shift_policy_snapshot (tenant_id, id) ON DELETE RESTRICT,
  CHECK ((outcome = 'APPLIED' AND resource_version IS NOT NULL AND reason_code IS NULL)
    OR (outcome = 'REJECTED' AND resource_version IS NULL AND reason_code IS NOT NULL))
);

ALTER TABLE execution.driver_action_receipt ENABLE ROW LEVEL SECURITY;
ALTER TABLE execution.driver_action_receipt FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON execution.driver_action_receipt
  USING (tenant_id = platform.current_tenant_id())
  WITH CHECK (tenant_id = platform.current_tenant_id());

CREATE FUNCTION execution.reject_driver_action_receipt_mutation()
RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
  RAISE EXCEPTION 'DRIVER_ACTION_RECEIPT_IMMUTABLE' USING ERRCODE = '23514';
END
$function$;
CREATE TRIGGER driver_action_receipt_immutable BEFORE UPDATE OR DELETE ON execution.driver_action_receipt
FOR EACH ROW EXECUTE FUNCTION execution.reject_driver_action_receipt_mutation();

REVOKE ALL ON execution.driver_action_receipt FROM PUBLIC;
GRANT SELECT, INSERT ON execution.driver_action_receipt TO kavaroutes_api;

RESET ROLE;

COMMIT;
