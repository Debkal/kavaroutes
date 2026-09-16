BEGIN;
SET LOCAL ROLE kavaroutes_migration;

-- A generation changes even on revoke/reactivate, preventing old sessions
-- becoming valid again. Administrative writes remain separately restricted.
CREATE FUNCTION platform.bump_membership_generation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.user_id IS DISTINCT FROM OLD.user_id THEN
  RAISE EXCEPTION 'IDENTITY_MEMBERSHIP_KEY_IMMUTABLE';
 END IF;
 NEW.authorization_generation := GREATEST(OLD.authorization_generation+1,NEW.authorization_generation);
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION platform.bump_membership_generation() FROM PUBLIC;
CREATE TRIGGER membership_generation BEFORE UPDATE ON platform.application_membership
FOR EACH ROW EXECUTE FUNCTION platform.bump_membership_generation();

CREATE FUNCTION platform.invalidate_identity_sessions() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
 IF TG_TABLE_NAME='application_user' THEN
  UPDATE platform.application_membership SET authorization_generation=authorization_generation+1
   WHERE tenant_id=OLD.tenant_id AND user_id=OLD.id;
 ELSE
  UPDATE platform.application_membership SET authorization_generation=authorization_generation+1
   WHERE tenant_id=OLD.tenant_id AND user_id=OLD.user_id;
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION platform.invalidate_identity_sessions() FROM PUBLIC;
CREATE TRIGGER user_session_generation AFTER UPDATE ON platform.application_user
FOR EACH ROW EXECUTE FUNCTION platform.invalidate_identity_sessions();
CREATE TRIGGER binding_session_generation AFTER UPDATE OR DELETE ON platform.identity_binding
FOR EACH ROW EXECUTE FUNCTION platform.invalidate_identity_sessions();

CREATE TABLE platform.application_session (
 tenant_id uuid NOT NULL,
 token_hash text NOT NULL CHECK(token_hash ~ '^[a-f0-9]{64}$'),
 csrf_hash text NOT NULL CHECK(csrf_hash ~ '^[a-f0-9]{64}$'),
 user_id uuid NOT NULL, principal_id uuid NOT NULL,
 issuer text NOT NULL, subject text NOT NULL,
 authorization_generation bigint NOT NULL CHECK(authorization_generation>0),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 expires_at timestamptz NOT NULL,
 revoked_at timestamptz,
 PRIMARY KEY(tenant_id,token_hash),
 FOREIGN KEY(tenant_id,user_id) REFERENCES platform.application_membership(tenant_id,user_id),
 CHECK(expires_at>created_at AND expires_at<=created_at+interval '1 hour')
);
CREATE INDEX application_session_expiry ON platform.application_session(expires_at);
ALTER TABLE platform.application_session ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.application_session FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON platform.application_session
 USING(tenant_id=platform.current_tenant_id()) WITH CHECK(tenant_id=platform.current_tenant_id());
REVOKE ALL ON platform.application_session FROM PUBLIC;
GRANT SELECT,INSERT ON platform.application_session TO kavaroutes_api;
GRANT UPDATE(revoked_at) ON platform.application_session TO kavaroutes_api;
COMMIT;
