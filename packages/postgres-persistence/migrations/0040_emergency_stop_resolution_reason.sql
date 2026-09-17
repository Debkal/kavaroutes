BEGIN;
SET LOCAL ROLE kavaroutes_migration;

-- The reviewer may now end an emergency-stopped shift whose legs are not all terminal,
-- recording the unresolved riders as acknowledged (audit WEB-A-028). That closure needs
-- its own reason code, so the column accepts it.
ALTER TABLE execution.driver_shift_closure DROP CONSTRAINT driver_shift_closure_reason_code_check;
ALTER TABLE execution.driver_shift_closure ADD CONSTRAINT driver_shift_closure_reason_code_check
  CHECK (reason_code IN('NORMAL_SIGN_OFF','SAFETY','PRIVACY','DEVICE_PROBLEM','OTHER','RETURN_EXCEPTION_REVIEWED','EMERGENCY_STOP_RESOLVED'));

COMMIT;
