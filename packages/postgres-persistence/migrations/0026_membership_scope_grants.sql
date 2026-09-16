BEGIN;
SET LOCAL ROLE kavaroutes_migration;

-- Explicit, company-scoped membership grants. Rows exist only because an
-- administrator provisioned them: the API role may read them and can never
-- write them, so a browser cannot widen its own capabilities or scopes. Scope
-- references are derived from the tenant by the application (branch:<tenant>,
-- fleet:<tenant>), so a grant can never name another company's scope, and no
-- synthetic wildcard scope is copied into a real membership.
CREATE TABLE platform.membership_scope_grant (
 tenant_id uuid NOT NULL,
 user_id uuid NOT NULL,
 scope_kind text NOT NULL CHECK(scope_kind IN('BRANCH','FLEET')),
 active boolean NOT NULL DEFAULT false,
 granted_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,user_id,scope_kind),
 FOREIGN KEY(tenant_id,user_id) REFERENCES platform.application_membership(tenant_id,user_id)
);

-- Capabilities that are never implied by a role (policy override, fleet command,
-- facility/billing/integration/audit operations) require a separate explicit
-- grant. Role defaults stay server-owned in the API contracts.
CREATE TABLE platform.membership_capability_grant (
 tenant_id uuid NOT NULL,
 user_id uuid NOT NULL,
 capability text NOT NULL CHECK(capability IN('driver-policy:write','driver-policy:override',
   'driver-route:self-approve','fleet:command','facility:trip-status:read','facility:coordinate',
   'billing:read','billing:command','integrations:read','integrations:write','audit:read')),
 active boolean NOT NULL DEFAULT false,
 granted_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,user_id,capability),
 FOREIGN KEY(tenant_id,user_id) REFERENCES platform.application_membership(tenant_id,user_id)
);

ALTER TABLE platform.membership_scope_grant ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.membership_scope_grant FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON platform.membership_scope_grant
 USING(tenant_id=platform.current_tenant_id()) WITH CHECK(tenant_id=platform.current_tenant_id());
ALTER TABLE platform.membership_capability_grant ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.membership_capability_grant FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON platform.membership_capability_grant
 USING(tenant_id=platform.current_tenant_id()) WITH CHECK(tenant_id=platform.current_tenant_id());
REVOKE ALL ON platform.membership_scope_grant,platform.membership_capability_grant FROM PUBLIC;
GRANT SELECT ON platform.membership_scope_grant,platform.membership_capability_grant TO kavaroutes_api;

-- Any grant change invalidates the affected membership's live sessions and
-- socket authority by advancing its authorization generation, including on
-- revoke and reactivate (the generation never moves backwards).
CREATE FUNCTION platform.invalidate_grant_sessions() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE target_tenant uuid; target_user uuid;
BEGIN
 target_tenant := COALESCE(NEW.tenant_id,OLD.tenant_id);
 target_user := COALESCE(NEW.user_id,OLD.user_id);
 UPDATE platform.application_membership SET authorization_generation=authorization_generation+1
  WHERE tenant_id=target_tenant AND user_id=target_user;
 RETURN COALESCE(NEW,OLD);
END $$;
REVOKE ALL ON FUNCTION platform.invalidate_grant_sessions() FROM PUBLIC;
CREATE TRIGGER scope_grant_session_generation AFTER INSERT OR UPDATE OR DELETE ON platform.membership_scope_grant
FOR EACH ROW EXECUTE FUNCTION platform.invalidate_grant_sessions();
CREATE TRIGGER capability_grant_session_generation AFTER INSERT OR UPDATE OR DELETE ON platform.membership_capability_grant
FOR EACH ROW EXECUTE FUNCTION platform.invalidate_grant_sessions();
COMMIT;
