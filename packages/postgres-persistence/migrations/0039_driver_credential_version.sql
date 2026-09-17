BEGIN;
SET LOCAL ROLE kavaroutes_migration;

-- A driver login could be invited exactly once, ever (audit WEB-A-024): the audit rows
-- used a hard-coded aggregate version, so the second invite collided with the audit
-- unique key instead of recording a new lifecycle step. The credential now carries its
-- own version, which every lifecycle step bumps and the audit rows record, so an invite,
-- a re-invite, a claim and a sign-in are distinct audited versions of one aggregate.
ALTER TABLE platform.driver_credential ADD COLUMN credential_version bigint NOT NULL DEFAULT 1
  CHECK (credential_version > 0);

COMMIT;
