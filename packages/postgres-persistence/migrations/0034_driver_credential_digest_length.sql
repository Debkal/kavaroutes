BEGIN;
SET LOCAL ROLE kavaroutes_migration;

-- scrypt at N=16384, r=8, p=1 derives 64 bytes, which hex-encodes to 128 characters.
-- 0033 bounded the stored digest at 32 bytes, so the claim UPDATE failed its own CHECK
-- and surfaced as an internal error instead of a claimed login. The constraint is
-- widened to the parameter range the application actually writes; the format, the salt
-- length and the scheme stay pinned.
ALTER TABLE platform.driver_credential DROP CONSTRAINT driver_credential_password_hash_check;
ALTER TABLE platform.driver_credential ADD CONSTRAINT driver_credential_password_hash_check
  CHECK (password_hash ~ '^scrypt\$[a-f0-9]{32}\$[0-9]+\$[0-9]+\$[0-9]+\$[a-f0-9]{64,256}$');

COMMIT;
