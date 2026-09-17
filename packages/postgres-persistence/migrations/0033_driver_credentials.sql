BEGIN;
SET LOCAL ROLE kavaroutes_migration;

-- Prototype-only driver logins. The human directed on 2026-09-17 that dispatch issues
-- driver logins and that each driver sets their own password on first use, so driver
-- logins stay separate. 0024 deliberately declared these identities "not a password
-- store" with "no API self-enrollment"; that decision is REVERSED here for the
-- synthetic prototype and must be revisited before any non-synthetic deployment.
--
-- Nothing recoverable is stored: the password keeps only a scrypt digest with its
-- parameters, the one-time invite code keeps only a SHA-256 hash, and the column is
-- cleared once the driver claims the login.
CREATE TABLE platform.driver_credential (
 tenant_id uuid NOT NULL,
 driver_id uuid NOT NULL,
 phone_e164 text NOT NULL CHECK (phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
 status text NOT NULL CHECK (status IN ('INVITED','ACTIVE','LOCKED')),
 invite_code_hash text CHECK (invite_code_hash ~ '^[a-f0-9]{64}$'),
 password_hash text CHECK (password_hash ~ '^scrypt\$[a-f0-9]{32}\$[0-9]+\$[0-9]+\$[0-9]+\$[a-f0-9]{64}$'),
 password_parameters jsonb CHECK (password_parameters IS NULL OR jsonb_typeof(password_parameters) = 'object'),
 claimed_installation text CHECK (claimed_installation IS NULL OR length(claimed_installation) BETWEEN 4 AND 128),
 failed_attempts integer NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0 AND failed_attempts <= 100),
 locked_until timestamptz,
 invited_at timestamptz NOT NULL DEFAULT now(),
 claimed_at timestamptz,
 last_login_at timestamptz,
 PRIMARY KEY (tenant_id, driver_id),
 UNIQUE (tenant_id, phone_e164),
 FOREIGN KEY (tenant_id, driver_id) REFERENCES fleet.driver (tenant_id, id),
 -- An invited login has no password yet; an active one must have both material
 -- columns; a locked one keeps whatever it had.
 CHECK (status <> 'INVITED' OR (password_hash IS NULL AND invite_code_hash IS NOT NULL)),
 CHECK (status <> 'ACTIVE' OR (password_hash IS NOT NULL AND invite_code_hash IS NULL AND claimed_at IS NOT NULL))
);

ALTER TABLE platform.driver_credential ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.driver_credential FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON platform.driver_credential
  USING (tenant_id = platform.current_tenant_id())
  WITH CHECK (tenant_id = platform.current_tenant_id());

REVOKE ALL ON platform.driver_credential FROM PUBLIC;
-- The api role writes credentials through the reviewed commands only; the
-- migration role keeps ownership of the table itself.
GRANT SELECT, INSERT, UPDATE ON platform.driver_credential TO kavaroutes_api;

COMMIT;
