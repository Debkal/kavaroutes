BEGIN;
SET LOCAL ROLE kavaroutes_migration;

-- The human directed 2026-09-17 that a driver login is identified by a simple ID, not a
-- phone number, so dispatch can hand out logins without a phone format. The column is
-- renamed and its constraint is widened to a bounded, human-typable identifier; the
-- unique key follows the rename.
ALTER TABLE platform.driver_credential RENAME COLUMN phone_e164 TO login_id;
-- Rows created while the column was a phone number carry a leading "+", which the
-- identifier rule does not allow. They have never been claimed by a real driver in this
-- prototype, so the separator is simply removed before the new CHECK is added; without
-- this the ADD CONSTRAINT fails on existing data. The table forces row level security,
-- and the migration role holds no app.tenant_id, so the normalisation runs inside the
-- one tenant this synthetic runtime serves.
SELECT set_config('app.tenant_id', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', true);
-- The phone-format constraint has to go before the values are rewritten, because the
-- rewritten values no longer match it.
ALTER TABLE platform.driver_credential DROP CONSTRAINT driver_credential_phone_e164_check;
UPDATE platform.driver_credential SET login_id = replace(login_id, '+', '');
ALTER TABLE platform.driver_credential ADD CONSTRAINT driver_credential_login_id_check
  CHECK (login_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$');

COMMIT;
