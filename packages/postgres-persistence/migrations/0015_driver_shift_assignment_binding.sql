BEGIN;
SET LOCAL ROLE kavaroutes_migration;
ALTER TABLE execution.shift_policy_snapshot ADD COLUMN pinned_assignment_version bigint CHECK(pinned_assignment_version>0);
-- Legacy snapshots lack a historical assignment version. Do not fabricate it from today's assignment.
CREATE FUNCTION execution.reject_shift_assignment_binding_mutation() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF NEW.pinned_assignment_version IS DISTINCT FROM OLD.pinned_assignment_version THEN
    RAISE EXCEPTION 'SHIFT_ASSIGNMENT_BINDING_IMMUTABLE' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END
$fn$;
CREATE TRIGGER shift_assignment_binding_immutable BEFORE UPDATE ON execution.shift_policy_snapshot
FOR EACH ROW EXECUTE FUNCTION execution.reject_shift_assignment_binding_mutation();
COMMIT;
