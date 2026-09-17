BEGIN;
SET LOCAL ROLE kavaroutes_migration;

-- A published delivery is normally finished: the transport owns it and a replay targets
-- the transport job. That breaks when the job is gone (dead-lettered and cleared, or
-- deleted during incident recovery) while the consumer never recorded the event, which
-- leaves the read model permanently behind (audit WEB-A-031). The operator backfill in
-- the runtime recovery path authorizes the request, checks that the route's consumer has
-- no record of the event, journals an outbox.consumer_transport_journal row with
-- action='REPLAY'/safe_code='OPERATOR_REVIEWED', and then moves the delivery back to
-- PENDING so the ordinary publisher re-creates the job. Only that path may take this
-- transition; the state machine still refuses every other published-state change.
CREATE OR REPLACE FUNCTION outbox.validate_delivery_transition()
RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
  IF NEW.lifecycle_version <> OLD.lifecycle_version + 1 THEN
    RAISE EXCEPTION 'OUTBOX_DELIVERY_VERSION_REQUIRED' USING ERRCODE = '40001';
  END IF;
  IF NOT (
    (OLD.status = 'PENDING' AND NEW.status IN ('LEASED','BLOCKED','DEAD_LETTERED')) OR
    (OLD.status = 'LEASED' AND NEW.status IN ('PENDING','PUBLISHED','BLOCKED','DEAD_LETTERED')) OR
    (OLD.status = 'LEASED' AND NEW.status = 'LEASED' AND OLD.lease_expires_at <= now()) OR
    (OLD.status = 'BLOCKED' AND NEW.status IN ('PENDING','DEAD_LETTERED')) OR
    (OLD.status = 'DEAD_LETTERED' AND NEW.status = 'PENDING') OR
    (OLD.status = 'PUBLISHED' AND NEW.status IN ('PUBLISHED','PENDING'))
  ) THEN
    RAISE EXCEPTION 'OUTBOX_DELIVERY_TRANSITION_INVALID' USING ERRCODE = '23514';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END
$function$;

COMMIT;
