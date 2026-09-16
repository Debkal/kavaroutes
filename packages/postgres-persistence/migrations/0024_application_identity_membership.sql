BEGIN;
SET LOCAL ROLE kavaroutes_migration;

-- Company-scoped application identities, not a password store. Only reviewed
-- administrative provisioning may write them; no API self-enrollment.
CREATE TABLE platform.application_user (
 tenant_id uuid NOT NULL, id uuid NOT NULL,
 organization_id uuid GENERATED ALWAYS AS (tenant_id) STORED,
 display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 120),
 active boolean NOT NULL DEFAULT false,
 PRIMARY KEY(tenant_id,id),
 FOREIGN KEY(tenant_id,organization_id) REFERENCES platform.organization(tenant_id,id)
);
CREATE TABLE platform.identity_binding (
 tenant_id uuid NOT NULL, user_id uuid NOT NULL,
 issuer text NOT NULL CHECK(length(issuer) BETWEEN 8 AND 512 AND issuer LIKE 'https://%'),
 subject text NOT NULL CHECK(length(subject) BETWEEN 1 AND 128),
 active boolean NOT NULL DEFAULT false,
 PRIMARY KEY(tenant_id,issuer,subject),
 FOREIGN KEY(tenant_id,user_id) REFERENCES platform.application_user(tenant_id,id)
);
CREATE TABLE platform.application_membership (
 tenant_id uuid NOT NULL, user_id uuid NOT NULL, principal_id uuid NOT NULL,
 active boolean NOT NULL DEFAULT false,
 authorization_generation bigint NOT NULL DEFAULT 1 CHECK(authorization_generation>0),
 role text NOT NULL CHECK(role IN('DRIVER','DISPATCHER')),
 driver_id uuid,
 PRIMARY KEY(tenant_id,user_id), UNIQUE(tenant_id,principal_id),
 FOREIGN KEY(tenant_id,user_id) REFERENCES platform.application_user(tenant_id,id),
 FOREIGN KEY(tenant_id,driver_id) REFERENCES fleet.driver(tenant_id,id),
 CHECK((role='DRIVER' AND driver_id IS NOT NULL) OR (role='DISPATCHER' AND driver_id IS NULL))
);

ALTER TABLE platform.application_user ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.application_user FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON platform.application_user USING(tenant_id=platform.current_tenant_id()) WITH CHECK(tenant_id=platform.current_tenant_id());
ALTER TABLE platform.identity_binding ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.identity_binding FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON platform.identity_binding USING(tenant_id=platform.current_tenant_id()) WITH CHECK(tenant_id=platform.current_tenant_id());
ALTER TABLE platform.application_membership ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.application_membership FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON platform.application_membership USING(tenant_id=platform.current_tenant_id()) WITH CHECK(tenant_id=platform.current_tenant_id());
REVOKE ALL ON platform.application_user,platform.identity_binding,platform.application_membership FROM PUBLIC;
GRANT SELECT ON platform.application_user,platform.identity_binding,platform.application_membership TO kavaroutes_api;
COMMIT;
