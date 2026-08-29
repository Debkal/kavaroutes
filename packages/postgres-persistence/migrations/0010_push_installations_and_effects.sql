BEGIN;

DO $roles$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kavaroutes_push_worker') THEN
    CREATE ROLE kavaroutes_push_worker NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;
END
$roles$;

CREATE SCHEMA IF NOT EXISTS notification AUTHORIZATION kavaroutes_migration;

SET LOCAL ROLE kavaroutes_migration;

CREATE TABLE notification.installation_registration (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL,
  organization_id uuid NOT NULL,
  principal_id uuid NOT NULL,
  subject_id uuid NOT NULL,
  installation_id uuid NOT NULL,
  installation_generation text NOT NULL CHECK (installation_generation ~ '^gen_[a-z0-9_-]{12,96}$'),
  platform text NOT NULL CHECK (platform IN ('ios','android')),
  provider text NOT NULL CHECK (provider IN ('apns','fcm')),
  provider_environment text NOT NULL CHECK (provider_environment IN ('sandbox','development')),
  app_identity text NOT NULL CHECK (app_identity ~ '^(com\.)?kavaroutes\.[a-z0-9.-]{3,80}$'),
  token_ciphertext bytea NOT NULL CHECK (octet_length(token_ciphertext) BETWEEN 32 AND 8192),
  token_keyed_hash bytea NOT NULL CHECK (octet_length(token_keyed_hash) = 32),
  permission_state text NOT NULL CHECK (permission_state IN ('not_requested','provisional','granted','denied','channel_limited','system_disabled')),
  channel_enabled boolean NOT NULL,
  policy_version text NOT NULL DEFAULT 'push.policy.v1' CHECK (policy_version = 'push.policy.v1'),
  lifecycle text NOT NULL DEFAULT 'ACTIVE' CHECK (lifecycle IN ('ACTIVE','INACTIVE')),
  inactive_reason text CHECK (inactive_reason IS NULL OR inactive_reason IN ('logout','deprovisioned','principal_switched','tenant_switched','installation_replaced','provider_invalid','remote_revocation','stale')),
  created_at timestamptz NOT NULL DEFAULT now(),
  refreshed_at timestamptz NOT NULL DEFAULT now(),
  last_confirmed_at timestamptz NOT NULL DEFAULT now(),
  invalidated_at timestamptz,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, installation_id, installation_generation),
  UNIQUE (tenant_id, provider, provider_environment, app_identity, token_keyed_hash),
  FOREIGN KEY (tenant_id, organization_id) REFERENCES platform.organization (tenant_id, id),
  CHECK ((platform = 'ios' AND provider = 'apns' AND provider_environment = 'sandbox') OR (platform = 'android' AND provider = 'fcm' AND provider_environment = 'development')),
  CHECK ((lifecycle = 'ACTIVE' AND inactive_reason IS NULL AND invalidated_at IS NULL) OR (lifecycle = 'INACTIVE' AND inactive_reason IS NOT NULL AND invalidated_at IS NOT NULL))
);

CREATE TABLE notification.intent (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL,
  source_event_id uuid NOT NULL,
  principal_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('sync_available','review_update','session_attention')),
  action text NOT NULL DEFAULT 'open_and_sync' CHECK (action = 'open_and_sync'),
  envelope jsonb NOT NULL,
  policy_version text NOT NULL DEFAULT 'push.policy.v1' CHECK (policy_version = 'push.policy.v1'),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, source_event_id, principal_id, kind),
  CHECK (envelope = jsonb_build_object('v','1','kind',kind,'action','open_and_sync')),
  CHECK (expires_at = created_at + interval '5 minutes')
);

CREATE TABLE notification.outbound_effect (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL,
  intent_id uuid NOT NULL,
  registration_id uuid NOT NULL,
  logical_effect_key text NOT NULL CHECK (logical_effect_key ~ '^effect_[a-z0-9_-]{12,96}$'),
  state text NOT NULL DEFAULT 'PLANNED' CHECK (state IN ('PLANNED','IN_FLIGHT','PROVIDER_ACCEPTED','RETRY_SCHEDULED','PERMANENT','AMBIGUOUS','SUPERSEDED','EXPIRED')),
  normalized_outcome text CHECK (normalized_outcome IS NULL OR normalized_outcome IN ('accepted','invalid_registration','permanent_payload_or_auth','throttled','transient_provider','ambiguous_timeout','superseded','expired')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 5),
  next_attempt_at timestamptz,
  provider_reference_hash bytea CHECK (provider_reference_hash IS NULL OR octet_length(provider_reference_hash) = 32),
  safe_code text CHECK (safe_code IS NULL OR safe_code ~ '^[A-Z][A-Z0-9_]{2,63}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, logical_effect_key),
  UNIQUE (tenant_id, intent_id, registration_id),
  FOREIGN KEY (tenant_id, intent_id) REFERENCES notification.intent (tenant_id, id),
  FOREIGN KEY (tenant_id, registration_id) REFERENCES notification.installation_registration (tenant_id, id),
  CHECK ((state = 'RETRY_SCHEDULED') = (next_attempt_at IS NOT NULL))
);

CREATE INDEX notification_registration_active_principal_idx ON notification.installation_registration (tenant_id, principal_id, refreshed_at DESC) WHERE lifecycle = 'ACTIVE';
CREATE INDEX notification_registration_stale_idx ON notification.installation_registration (tenant_id, last_confirmed_at) WHERE lifecycle = 'ACTIVE';
CREATE INDEX notification_intent_expiry_idx ON notification.intent (tenant_id, expires_at);
CREATE INDEX notification_effect_retry_idx ON notification.outbound_effect (tenant_id, next_attempt_at) WHERE state = 'RETRY_SCHEDULED';

DO $rls$
DECLARE item text;
BEGIN
  FOREACH item IN ARRAY ARRAY['installation_registration','intent','outbound_effect']
  LOOP
    EXECUTE format('ALTER TABLE notification.%I ENABLE ROW LEVEL SECURITY', item);
    EXECUTE format('ALTER TABLE notification.%I FORCE ROW LEVEL SECURITY', item);
    EXECUTE format('CREATE POLICY tenant_isolation ON notification.%I USING (tenant_id = platform.current_tenant_id()) WITH CHECK (tenant_id = platform.current_tenant_id())', item);
  END LOOP;
END
$rls$;

SELECT platform.assert_tenant_boundaries();

RESET ROLE;

REVOKE ALL ON SCHEMA notification FROM PUBLIC;
REVOKE ALL ON notification.installation_registration, notification.intent, notification.outbound_effect FROM PUBLIC;
GRANT USAGE ON SCHEMA notification TO kavaroutes_api, kavaroutes_worker, kavaroutes_push_worker, kavaroutes_outbox_consumer;
GRANT SELECT, INSERT, UPDATE ON notification.installation_registration TO kavaroutes_api;
GRANT SELECT ON notification.installation_registration TO kavaroutes_push_worker;
GRANT SELECT, INSERT ON notification.intent TO kavaroutes_worker, kavaroutes_outbox_consumer, kavaroutes_push_worker;
GRANT SELECT, INSERT, UPDATE ON notification.outbound_effect TO kavaroutes_push_worker;
GRANT EXECUTE ON FUNCTION platform.current_tenant_id() TO kavaroutes_push_worker;

COMMIT;
