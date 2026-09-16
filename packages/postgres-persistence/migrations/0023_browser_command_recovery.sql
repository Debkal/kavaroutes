BEGIN;
SET LOCAL ROLE kavaroutes_migration;
-- Server-held original requests; never browser storage or permission to execute.
CREATE TABLE platform.browser_command_recovery (
 tenant_id uuid NOT NULL,
 organization_id uuid GENERATED ALWAYS AS (tenant_id) STORED,
 actor_id uuid NOT NULL,id uuid NOT NULL,
 kind text NOT NULL CHECK(kind IN('CREATE_TRIP','CANCEL_TRIP','ASSIGN_RUN','DECIDE_ROUTE','OVERRIDE_RETURN')),
 envelope jsonb NOT NULL CHECK(jsonb_typeof(envelope)='object' AND octet_length(envelope::text)<=16384),
 result jsonb CHECK(jsonb_typeof(result)='object' AND octet_length(result::text)<=65536),
 created_at timestamptz NOT NULL DEFAULT now(),
 expires_at timestamptz NOT NULL DEFAULT now()+interval '22 hours',
 completed_at timestamptz,acknowledged_at timestamptz,
 PRIMARY KEY(tenant_id,id),
 FOREIGN KEY(tenant_id,organization_id) REFERENCES platform.organization(tenant_id,id),
 CHECK(expires_at>created_at),
 CHECK((result IS NULL)=(completed_at IS NULL)),
 CHECK(acknowledged_at IS NULL OR completed_at IS NOT NULL)
);
CREATE UNIQUE INDEX browser_command_one_unacknowledged ON platform.browser_command_recovery(tenant_id,actor_id) WHERE acknowledged_at IS NULL;
ALTER TABLE platform.browser_command_recovery ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.browser_command_recovery FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON platform.browser_command_recovery USING(tenant_id=platform.current_tenant_id()) WITH CHECK(tenant_id=platform.current_tenant_id());
REVOKE ALL ON platform.browser_command_recovery FROM PUBLIC;
GRANT SELECT,INSERT,UPDATE ON platform.browser_command_recovery TO kavaroutes_api;
CREATE FUNCTION platform.guard_browser_command_recovery() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'BROWSER_COMMAND_IMMUTABLE' USING ERRCODE='23514'; END IF;
 IF (NEW.tenant_id,NEW.actor_id,NEW.id,NEW.kind,NEW.envelope,NEW.created_at,NEW.expires_at)
 IS DISTINCT FROM (OLD.tenant_id,OLD.actor_id,OLD.id,OLD.kind,OLD.envelope,OLD.created_at,OLD.expires_at)
 OR (OLD.result IS NOT NULL AND (NEW.result,NEW.completed_at) IS DISTINCT FROM (OLD.result,OLD.completed_at))
 OR (OLD.acknowledged_at IS NOT NULL AND NEW.acknowledged_at IS DISTINCT FROM OLD.acknowledged_at)
 THEN RAISE EXCEPTION 'BROWSER_COMMAND_IMMUTABLE' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER browser_command_immutable BEFORE UPDATE OR DELETE ON platform.browser_command_recovery FOR EACH ROW EXECUTE FUNCTION platform.guard_browser_command_recovery();
COMMIT;
