BEGIN;

SET LOCAL timezone = 'UTC';

DO $roles$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kavaroutes_outbox_publisher') THEN
    CREATE ROLE kavaroutes_outbox_publisher NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kavaroutes_outbox_consumer') THEN
    CREATE ROLE kavaroutes_outbox_consumer NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;
END
$roles$;

CREATE SCHEMA IF NOT EXISTS outbox AUTHORIZATION kavaroutes_migration;

SET LOCAL ROLE kavaroutes_migration;

CREATE TABLE outbox.message (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL,
  event_id uuid NOT NULL,
  aggregate_type text NOT NULL CHECK (aggregate_type ~ '^[A-Z][A-Z0-9_]{2,63}$'),
  aggregate_id uuid NOT NULL,
  aggregate_version bigint NOT NULL CHECK (aggregate_version > 0),
  event_type text NOT NULL CHECK (event_type ~ '^[A-Z][A-Za-z0-9]{2,95}$'),
  schema_version text NOT NULL CHECK (schema_version ~ '^v[1-9][0-9]*$'),
  occurred_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  command_id uuid NOT NULL,
  idempotency_reference_hash text NOT NULL CHECK (idempotency_reference_hash ~ '^[0-9a-f]{64}$'),
  correlation_id uuid NOT NULL,
  causation_id uuid,
  source text NOT NULL CHECK (source ~ '^[a-z][a-z0-9.-]{2,63}$'),
  classification_reference text NOT NULL CHECK (classification_reference ~ '^[A-Z][A-Z0-9_]{2,63}$'),
  purpose_reference text NOT NULL CHECK (purpose_reference ~ '^[A-Z][A-Z0-9_]{2,63}$'),
  policy_reference text NOT NULL CHECK (policy_reference ~ '^[a-z][a-z0-9._-]{2,63}$'),
  payload jsonb,
  payload_reference text,
  retention_marked_at timestamptz,
  retain_until timestamptz NOT NULL DEFAULT (now() + interval '30 days'),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, event_id),
  CHECK ((payload IS NULL) <> (payload_reference IS NULL)),
  CHECK (payload_reference IS NULL OR payload_reference ~ '^ref_[a-z0-9_-]{8,96}$'),
  CHECK (retain_until >= recorded_at + interval '30 days')
);

CREATE TABLE outbox.delivery (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL,
  message_id uuid NOT NULL,
  route text NOT NULL CHECK (route IN ('projection','realtime-signal','integration','notification','maps','optimization','billing','maintenance')),
  job_type text NOT NULL CHECK (job_type ~ '^kr\.[a-z][a-z0-9.-]{2,63}\.v[1-9][0-9]*$'),
  available_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','LEASED','PUBLISHED','BLOCKED','DEAD_LETTERED')),
  lease_owner text,
  lease_expires_at timestamptz,
  lease_version bigint NOT NULL DEFAULT 0 CHECK (lease_version >= 0),
  publish_attempts integer NOT NULL DEFAULT 0 CHECK (publish_attempts >= 0),
  first_published_at timestamptz,
  last_published_at timestamptz,
  transport_reference text,
  safe_failure_code text CHECK (safe_failure_code IS NULL OR safe_failure_code ~ '^[A-Z][A-Z0-9_]{2,63}$'),
  dead_lettered_at timestamptz,
  lifecycle_version bigint NOT NULL DEFAULT 1 CHECK (lifecycle_version > 0),
  reconciled_at timestamptz,
  retain_until timestamptz NOT NULL DEFAULT (now() + interval '30 days'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, message_id, route),
  FOREIGN KEY (tenant_id, message_id) REFERENCES outbox.message (tenant_id, id) ON DELETE RESTRICT,
  CHECK ((status = 'LEASED') = (lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)),
  CHECK (status <> 'PUBLISHED' OR transport_reference IS NOT NULL),
  CHECK (status <> 'DEAD_LETTERED' OR (dead_lettered_at IS NOT NULL AND safe_failure_code IS NOT NULL)),
  CHECK (retain_until >= created_at + interval '30 days')
);

CREATE TABLE outbox.delivery_attempt (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL,
  delivery_id uuid NOT NULL,
  attempt_number integer NOT NULL CHECK (attempt_number > 0),
  attempt_kind text NOT NULL CHECK (attempt_kind IN ('CLAIM','RECLAIM','PUBLISH','FAIL','REDRIVE')),
  outcome text NOT NULL CHECK (outcome IN ('LEASED','COMMITTED','ROLLED_BACK','RETRY_SCHEDULED','DEAD_LETTERED')),
  safe_error_class text CHECK (safe_error_class IS NULL OR safe_error_class ~ '^[A-Z][A-Z0-9_]{2,63}$'),
  worker_version text NOT NULL CHECK (worker_version ~ '^wp008\.[a-z0-9.-]{1,48}$'),
  original_attempt_id uuid,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  duration_ms integer NOT NULL DEFAULT 0 CHECK (duration_ms >= 0),
  retain_until timestamptz NOT NULL DEFAULT (now() + interval '30 days'),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, delivery_id, attempt_number, attempt_kind),
  FOREIGN KEY (tenant_id, delivery_id) REFERENCES outbox.delivery (tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, original_attempt_id) REFERENCES outbox.delivery_attempt (tenant_id, id) ON DELETE RESTRICT,
  CHECK (retain_until >= occurred_at + interval '30 days')
);

CREATE TABLE outbox.consumer_checkpoint (
  tenant_id uuid NOT NULL,
  consumer_name text NOT NULL CHECK (consumer_name ~ '^[a-z][a-z0-9.-]{2,63}$'),
  aggregate_type text NOT NULL,
  aggregate_id uuid NOT NULL,
  last_applied_version bigint NOT NULL DEFAULT 0 CHECK (last_applied_version >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, consumer_name, aggregate_type, aggregate_id)
);

CREATE TABLE outbox.consumer_inbox (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL,
  consumer_name text NOT NULL CHECK (consumer_name ~ '^[a-z][a-z0-9.-]{2,63}$'),
  event_id uuid NOT NULL,
  aggregate_type text NOT NULL,
  aggregate_id uuid NOT NULL,
  aggregate_version bigint NOT NULL CHECK (aggregate_version > 0),
  processing_state text NOT NULL CHECK (processing_state IN ('COMPLETED','OBSOLETE')),
  handler_version text NOT NULL CHECK (handler_version ~ '^v[1-9][0-9]*$'),
  schema_version text NOT NULL CHECK (schema_version ~ '^v[1-9][0-9]*$'),
  safe_result_reference text NOT NULL CHECK (safe_result_reference ~ '^ref_[a-z0-9_-]{8,96}$'),
  committed_at timestamptz NOT NULL DEFAULT now(),
  retain_until timestamptz NOT NULL DEFAULT (now() + interval '30 days'),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, consumer_name, event_id),
  UNIQUE (tenant_id, consumer_name, aggregate_type, aggregate_id, aggregate_version),
  CHECK (retain_until >= committed_at + interval '30 days')
);

CREATE TABLE outbox.consumer_projection (
  tenant_id uuid NOT NULL,
  consumer_name text NOT NULL,
  aggregate_type text NOT NULL,
  aggregate_id uuid NOT NULL,
  applied_version bigint NOT NULL CHECK (applied_version > 0),
  safe_state text NOT NULL CHECK (safe_state ~ '^[A-Z][A-Z0-9_]{2,63}$'),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, consumer_name, aggregate_type, aggregate_id)
);

CREATE TABLE outbox.outbound_effect (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL,
  logical_effect_key text NOT NULL CHECK (logical_effect_key ~ '^effect_[a-z0-9_-]{8,96}$'),
  event_id uuid NOT NULL,
  delivery_id uuid NOT NULL,
  provider_operation text NOT NULL CHECK (provider_operation ~ '^[A-Z][A-Z0-9_]{2,63}$'),
  attempt_state text NOT NULL CHECK (attempt_state IN ('PLANNED','IN_FLIGHT','SUCCEEDED','RECONCILED','PERMANENT_FAILURE','MANUAL_REVIEW')),
  provider_idempotency_hash text NOT NULL CHECK (provider_idempotency_hash ~ '^[0-9a-f]{64}$'),
  provider_reference_hash text CHECK (provider_reference_hash IS NULL OR provider_reference_hash ~ '^[0-9a-f]{64}$'),
  request_fingerprint text NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  reconciliation_state text NOT NULL CHECK (reconciliation_state IN ('NOT_REQUIRED','PENDING','CONFIRMED','UNAVAILABLE')),
  safe_outcome_code text CHECK (safe_outcome_code IS NULL OR safe_outcome_code ~ '^[A-Z][A-Z0-9_]{2,63}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  reconciled_at timestamptz,
  retain_until timestamptz NOT NULL DEFAULT (now() + interval '30 days'),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, logical_effect_key),
  FOREIGN KEY (tenant_id, delivery_id) REFERENCES outbox.delivery (tenant_id, id) ON DELETE RESTRICT,
  CHECK (retain_until >= created_at + interval '30 days')
);

CREATE TABLE outbox.route_control (
  tenant_id uuid NOT NULL,
  route text NOT NULL CHECK (route IN ('projection','realtime-signal','integration','notification','maps','optimization','billing','maintenance')),
  paused boolean NOT NULL DEFAULT false,
  kill_switch boolean NOT NULL DEFAULT false,
  reason_code text NOT NULL DEFAULT 'ROUTE_ACTIVE' CHECK (reason_code ~ '^[A-Z][A-Z0-9_]{2,63}$'),
  actor_reference text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, route)
);

CREATE TABLE outbox.replay_operation (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL,
  route text NOT NULL,
  event_id uuid,
  from_recorded_at timestamptz,
  to_recorded_at timestamptz,
  dry_run boolean NOT NULL,
  candidate_count integer NOT NULL CHECK (candidate_count >= 0),
  side_effect_class text NOT NULL CHECK (side_effect_class IN ('INTERNAL','EXTERNAL_IDEMPOTENT','EXTERNAL_AMBIGUOUS')),
  cost_units integer NOT NULL DEFAULT 0 CHECK (cost_units >= 0),
  reason_code text NOT NULL CHECK (reason_code ~ '^[A-Z][A-Z0-9_]{2,63}$'),
  actor_reference text NOT NULL,
  status text NOT NULL CHECK (status IN ('PLANNED','RUNNING','PAUSED','COMPLETED','CANCELLED')),
  checkpoint_delivery_id uuid,
  rate_limit_per_minute integer NOT NULL CHECK (rate_limit_per_minute BETWEEN 1 AND 1000),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, checkpoint_delivery_id) REFERENCES outbox.delivery (tenant_id, id) ON DELETE RESTRICT,
  CHECK (from_recorded_at IS NULL OR to_recorded_at IS NULL OR from_recorded_at <= to_recorded_at)
);

CREATE INDEX outbox_delivery_ready_idx ON outbox.delivery (tenant_id, route, available_at, id)
  WHERE status IN ('PENDING','LEASED');
CREATE INDEX outbox_delivery_lease_idx ON outbox.delivery (tenant_id, lease_expires_at, id)
  WHERE status = 'LEASED';
CREATE INDEX outbox_delivery_retention_idx ON outbox.delivery (tenant_id, retain_until, id);
CREATE INDEX outbox_attempt_history_idx ON outbox.delivery_attempt (tenant_id, delivery_id, attempt_number);
CREATE INDEX outbox_inbox_aggregate_idx ON outbox.consumer_inbox (tenant_id, consumer_name, aggregate_type, aggregate_id, aggregate_version);
CREATE INDEX outbox_effect_state_idx ON outbox.outbound_effect (tenant_id, attempt_state, updated_at, id);
CREATE INDEX outbox_message_recorded_idx ON outbox.message (tenant_id, recorded_at, id);

CREATE OR REPLACE FUNCTION outbox.reject_immutable_mutation()
RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
  RAISE EXCEPTION 'OUTBOX_IMMUTABLE_RECORD' USING ERRCODE = '55000';
END
$function$;

CREATE TRIGGER message_immutable BEFORE UPDATE OR DELETE ON outbox.message
FOR EACH ROW EXECUTE FUNCTION outbox.reject_immutable_mutation();
CREATE TRIGGER delivery_attempt_immutable BEFORE UPDATE OR DELETE ON outbox.delivery_attempt
FOR EACH ROW EXECUTE FUNCTION outbox.reject_immutable_mutation();

CREATE OR REPLACE FUNCTION outbox.validate_delivery_transition()
RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
  IF NEW.lifecycle_version <> OLD.lifecycle_version + 1 THEN
    RAISE EXCEPTION 'OUTBOX_DELIVERY_VERSION_REQUIRED' USING ERRCODE = '40001';
  END IF;
  IF NOT (
    (OLD.status = 'PENDING' AND NEW.status IN ('LEASED','BLOCKED','DEAD_LETTERED')) OR
    (OLD.status = 'LEASED' AND NEW.status IN ('PENDING','PUBLISHED','BLOCKED','DEAD_LETTERED')) OR
    (OLD.status = 'LEASED' AND NEW.status = 'LEASED' AND OLD.lease_expires_at <= now()) OR
    (OLD.status = 'BLOCKED' AND NEW.status IN ('PENDING','DEAD_LETTERED')) OR
    (OLD.status = 'DEAD_LETTERED' AND NEW.status = 'PENDING') OR
    (OLD.status = 'PUBLISHED' AND NEW.status = 'PUBLISHED')
  ) THEN
    RAISE EXCEPTION 'OUTBOX_DELIVERY_TRANSITION_INVALID' USING ERRCODE = '23514';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END
$function$;

CREATE TRIGGER delivery_transition BEFORE UPDATE ON outbox.delivery
FOR EACH ROW EXECUTE FUNCTION outbox.validate_delivery_transition();

DO $rls$
DECLARE item record;
BEGIN
  FOR item IN SELECT tablename FROM pg_tables WHERE schemaname = 'outbox'
  LOOP
    EXECUTE format('ALTER TABLE outbox.%I ENABLE ROW LEVEL SECURITY', item.tablename);
    EXECUTE format('ALTER TABLE outbox.%I FORCE ROW LEVEL SECURITY', item.tablename);
    EXECUTE format('CREATE POLICY tenant_isolation ON outbox.%I USING (tenant_id = platform.current_tenant_id()) WITH CHECK (tenant_id = platform.current_tenant_id())', item.tablename);
  END LOOP;
END
$rls$;

CREATE OR REPLACE FUNCTION platform.assert_tenant_boundaries()
RETURNS void LANGUAGE plpgsql AS $function$
DECLARE violation text;
BEGIN
  SELECT string_agg(problem, E'\n' ORDER BY problem) INTO violation FROM (
    SELECT format('%I.%I: missing immutable tenant_id', n.nspname, c.relname) AS problem
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    LEFT JOIN pg_attribute a ON a.attrelid=c.oid AND a.attname='tenant_id' AND NOT a.attisdropped
    WHERE n.nspname IN ('platform','intake','fleet','dispatch','execution','realtime','billing','integration','audit','outbox')
      AND c.relkind IN ('r','p') AND NOT c.relispartition AND (a.attname IS NULL OR NOT a.attnotnull)
    UNION ALL
    SELECT format('%I.%I: tenant_id is not first in %s constraint %I',n.nspname,c.relname,con.contype,con.conname)
    FROM pg_constraint con JOIN pg_class c ON c.oid=con.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname IN ('platform','intake','fleet','dispatch','execution','realtime','billing','integration','audit','outbox')
      AND con.contype IN ('p','u','f') AND (SELECT a.attname FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum=con.conkey[1]) IS DISTINCT FROM 'tenant_id'
    UNION ALL
    SELECT format('%I.%I: tenant_id is not first in index %I',n.nspname,c.relname,i.relname)
    FROM pg_index x JOIN pg_class c ON c.oid=x.indrelid JOIN pg_class i ON i.oid=x.indexrelid
    JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_am am ON am.oid=i.relam
    WHERE n.nspname IN ('platform','intake','fleet','dispatch','execution','realtime','billing','integration','audit','outbox')
      AND NOT c.relispartition AND am.amname <> 'brin'
      AND (SELECT a.attname FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum=x.indkey[0]) IS DISTINCT FROM 'tenant_id'
    UNION ALL
    SELECT format('%I.%I: RLS is not enabled and forced',n.nspname,c.relname)
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname IN ('platform','intake','fleet','dispatch','execution','realtime','billing','integration','audit','outbox')
      AND c.relkind IN ('r','p') AND NOT c.relispartition AND (NOT c.relrowsecurity OR NOT c.relforcerowsecurity)
  ) failures;
  IF violation IS NOT NULL THEN RAISE EXCEPTION 'TENANT_BOUNDARY_AUDIT_FAILED:%', E'\n'||violation; END IF;
END
$function$;

SELECT platform.assert_tenant_boundaries();

RESET ROLE;

REVOKE ALL ON SCHEMA outbox FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA outbox FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA outbox FROM PUBLIC;
GRANT USAGE ON SCHEMA outbox TO kavaroutes_api, kavaroutes_worker, kavaroutes_outbox_publisher, kavaroutes_outbox_consumer;
GRANT SELECT, INSERT ON outbox.message TO kavaroutes_api;
GRANT SELECT, INSERT ON outbox.delivery TO kavaroutes_api;
GRANT SELECT ON outbox.message TO kavaroutes_outbox_publisher, kavaroutes_outbox_consumer;
GRANT SELECT, UPDATE ON outbox.delivery TO kavaroutes_outbox_publisher, kavaroutes_outbox_consumer;
GRANT SELECT, INSERT ON outbox.delivery_attempt TO kavaroutes_outbox_publisher, kavaroutes_outbox_consumer;
GRANT SELECT, INSERT, UPDATE ON outbox.consumer_checkpoint, outbox.consumer_inbox, outbox.consumer_projection, outbox.outbound_effect TO kavaroutes_outbox_consumer;
GRANT SELECT, INSERT, UPDATE ON outbox.route_control, outbox.replay_operation TO kavaroutes_outbox_consumer;
GRANT SELECT ON outbox.consumer_checkpoint, outbox.consumer_inbox, outbox.consumer_projection, outbox.outbound_effect, outbox.route_control, outbox.replay_operation TO kavaroutes_outbox_publisher;
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA outbox TO kavaroutes_worker;
GRANT EXECUTE ON FUNCTION outbox.reject_immutable_mutation() TO kavaroutes_api, kavaroutes_worker, kavaroutes_outbox_publisher, kavaroutes_outbox_consumer;
GRANT EXECUTE ON FUNCTION outbox.validate_delivery_transition() TO kavaroutes_api, kavaroutes_worker, kavaroutes_outbox_publisher, kavaroutes_outbox_consumer;
GRANT EXECUTE ON FUNCTION platform.current_tenant_id() TO kavaroutes_outbox_publisher, kavaroutes_outbox_consumer;

ALTER DEFAULT PRIVILEGES FOR ROLE kavaroutes_migration REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE kavaroutes_migration REVOKE ALL ON FUNCTIONS FROM PUBLIC;

COMMIT;
