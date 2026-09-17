BEGIN;
SET LOCAL ROLE kavaroutes_migration;

-- PostgreSQL's regex engine rejects a repetition count above 255, so the
-- `[a-f0-9]{64,256}` bound added in 0034 made the CHECK itself raise
-- "invalid repetition count(s)" on every write to the table, which surfaced as an
-- internal error. The digest length is bounded with length() instead, and the format
-- keeps its pinned scheme, salt length and numeric parameters.
ALTER TABLE platform.driver_credential DROP CONSTRAINT driver_credential_password_hash_check;
ALTER TABLE platform.driver_credential ADD CONSTRAINT driver_credential_password_hash_check
  CHECK (password_hash ~ '^scrypt\$[a-f0-9]{32}\$[0-9]+\$[0-9]+\$[0-9]+\$[a-f0-9]+$'
    AND length(password_hash) BETWEEN 100 AND 400);

COMMIT;
