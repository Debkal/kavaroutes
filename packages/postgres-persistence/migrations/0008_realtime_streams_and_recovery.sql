BEGIN;

DO $roles$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kavaroutes_realtime') THEN
    CREATE ROLE kavaroutes_realtime NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;
END
$roles$;

SET LOCAL ROLE kavaroutes_migration;

CREATE TABLE realtime.stream (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL,
  purpose text NOT NULL CHECK (purpose IN ('DISPATCH_CONTROL','DRIVER_MANIFEST','FACILITY_COORDINATION','OPERATION_PROGRESS','DISPATCH_CURRENT_POSITION')),
  scope_kind text NOT NULL CHECK (scope_kind IN ('DISPATCH_DAY','DRIVER_MANIFEST','FACILITY_DAY','OPERATION','CURRENT_POSITION')),
  scope_hash bytea NOT NULL CHECK (octet_length(scope_hash) = 32),
  shard smallint NOT NULL DEFAULT 0 CHECK (shard BETWEEN 0 AND 255),
  epoch bigint NOT NULL DEFAULT 1 CHECK (epoch > 0),
  last_sequence bigint NOT NULL DEFAULT 0 CHECK (last_sequence >= 0),
  minimum_sequence bigint NOT NULL DEFAULT 1 CHECK (minimum_sequence > 0 AND minimum_sequence <= last_sequence + 1),
  projection_version text NOT NULL DEFAULT 'realtime.projection.v1' CHECK (projection_version = 'realtime.projection.v1'),
  schema_version text NOT NULL DEFAULT 'realtime.schema.v1' CHECK (schema_version = 'realtime.schema.v1'),
  policy_version text NOT NULL DEFAULT 'realtime.policy.v1' CHECK (policy_version = 'realtime.policy.v1'),
  lifecycle text NOT NULL DEFAULT 'ACTIVE' CHECK (lifecycle IN ('ACTIVE','COMPACTING','RESET_REQUIRED','RETIRED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, purpose, scope_kind, scope_hash, shard)
);

CREATE TABLE realtime.projection (
  tenant_id uuid NOT NULL,
  stream_id uuid NOT NULL,
  resource_kind text NOT NULL CHECK (resource_kind ~ '^[a-z][a-z0-9-]{2,63}$'),
  resource_reference text NOT NULL CHECK (resource_reference ~ '^[a-z][a-z0-9:_-]{2,127}$'),
  resource_version bigint NOT NULL CHECK (resource_version > 0),
  schema_version text NOT NULL DEFAULT 'realtime.schema.v1' CHECK (schema_version = 'realtime.schema.v1'),
  policy_version text NOT NULL DEFAULT 'realtime.policy.v1' CHECK (policy_version = 'realtime.policy.v1'),
  payload jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, stream_id, resource_kind, resource_reference),
  FOREIGN KEY (tenant_id, stream_id) REFERENCES realtime.stream (tenant_id, id) ON DELETE RESTRICT,
  CHECK (jsonb_typeof(payload) = 'object')
);

CREATE TABLE realtime.change (
  tenant_id uuid NOT NULL,
  stream_id uuid NOT NULL,
  epoch bigint NOT NULL CHECK (epoch > 0),
  sequence_number bigint NOT NULL CHECK (sequence_number > 0),
  source_event_id uuid NOT NULL,
  delta_kind text NOT NULL CHECK (delta_kind IN ('RESOURCE_INVALIDATED','DISPATCH_CONTROL','DRIVER_MANIFEST','FACILITY_COORDINATION','OPERATION_PROGRESS','CURRENT_POSITION')),
  resource_kind text NOT NULL CHECK (resource_kind ~ '^[a-z][a-z0-9-]{2,63}$'),
  resource_reference text NOT NULL CHECK (resource_reference ~ '^[a-z][a-z0-9:_-]{2,127}$'),
  resource_version bigint NOT NULL CHECK (resource_version > 0),
  schema_version text NOT NULL DEFAULT 'realtime.schema.v1' CHECK (schema_version = 'realtime.schema.v1'),
  policy_version text NOT NULL DEFAULT 'realtime.policy.v1' CHECK (policy_version = 'realtime.policy.v1'),
  payload jsonb NOT NULL,
  coalesce_reference text,
  coalesce_bucket bigint,
  committed_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  compacted_at timestamptz,
  PRIMARY KEY (tenant_id, stream_id, epoch, sequence_number),
  FOREIGN KEY (tenant_id, stream_id) REFERENCES realtime.stream (tenant_id, id) ON DELETE RESTRICT,
  CHECK (jsonb_typeof(payload) = 'object'),
  CHECK ((coalesce_reference IS NULL) = (coalesce_bucket IS NULL)),
  CHECK (coalesce_reference IS NULL OR (delta_kind = 'CURRENT_POSITION' AND coalesce_reference ~ '^[a-z][a-z0-9:_-]{2,127}$')),
  CHECK (expires_at >= committed_at + CASE WHEN delta_kind = 'CURRENT_POSITION' THEN interval '15 minutes' ELSE interval '24 hours' END),
  CHECK (compacted_at IS NULL OR compacted_at >= committed_at)
);

CREATE TABLE realtime.consumer_checkpoint (
  tenant_id uuid NOT NULL,
  consumer_name text NOT NULL CHECK (consumer_name ~ '^[a-z][a-z0-9.-]{2,63}$'),
  source_event_id uuid NOT NULL,
  source_aggregate_type text NOT NULL CHECK (source_aggregate_type ~ '^[a-z][a-z0-9.-]{2,63}$'),
  source_aggregate_id uuid NOT NULL,
  source_aggregate_version bigint NOT NULL CHECK (source_aggregate_version > 0),
  stream_id uuid NOT NULL,
  stream_epoch bigint NOT NULL CHECK (stream_epoch > 0),
  stream_sequence bigint NOT NULL CHECK (stream_sequence > 0),
  outcome text NOT NULL CHECK (outcome IN ('APPLIED','COALESCED','OBSOLETE')),
  committed_at timestamptz NOT NULL DEFAULT now(),
  retain_until timestamptz NOT NULL DEFAULT (now() + interval '30 days'),
  PRIMARY KEY (tenant_id, consumer_name, source_event_id),
  UNIQUE (tenant_id, consumer_name, source_aggregate_type, source_aggregate_id, source_aggregate_version),
  FOREIGN KEY (tenant_id, stream_id) REFERENCES realtime.stream (tenant_id, id) ON DELETE RESTRICT,
  CHECK (retain_until >= committed_at + interval '30 days')
);

CREATE INDEX realtime_stream_active_idx ON realtime.stream (tenant_id, purpose, scope_kind, scope_hash, shard) WHERE lifecycle = 'ACTIVE';
CREATE INDEX realtime_change_replay_idx ON realtime.change (tenant_id, stream_id, epoch, sequence_number) WHERE compacted_at IS NULL;
CREATE INDEX realtime_change_expiry_idx ON realtime.change (tenant_id, expires_at, stream_id, sequence_number) WHERE compacted_at IS NULL;
CREATE UNIQUE INDEX realtime_change_coalesce_idx ON realtime.change (tenant_id, stream_id, coalesce_reference, coalesce_bucket) WHERE coalesce_reference IS NOT NULL;
CREATE INDEX realtime_checkpoint_aggregate_idx ON realtime.consumer_checkpoint (tenant_id, consumer_name, source_aggregate_type, source_aggregate_id, source_aggregate_version);

DO $rls$
DECLARE item text;
BEGIN
  FOREACH item IN ARRAY ARRAY['stream','projection','change','consumer_checkpoint']
  LOOP
    EXECUTE format('ALTER TABLE realtime.%I ENABLE ROW LEVEL SECURITY', item);
    EXECUTE format('ALTER TABLE realtime.%I FORCE ROW LEVEL SECURITY', item);
    EXECUTE format('CREATE POLICY tenant_isolation ON realtime.%I USING (tenant_id = platform.current_tenant_id()) WITH CHECK (tenant_id = platform.current_tenant_id())', item);
  END LOOP;
END
$rls$;

SELECT platform.assert_tenant_boundaries();

RESET ROLE;

REVOKE ALL ON realtime.stream, realtime.projection, realtime.change, realtime.consumer_checkpoint FROM PUBLIC;
GRANT USAGE ON SCHEMA realtime TO kavaroutes_realtime, kavaroutes_outbox_consumer;
GRANT SELECT ON realtime.stream, realtime.projection, realtime.change TO kavaroutes_api, kavaroutes_realtime;
GRANT SELECT, INSERT, UPDATE ON realtime.stream, realtime.projection, realtime.change, realtime.consumer_checkpoint TO kavaroutes_outbox_consumer, kavaroutes_worker;
GRANT SELECT ON realtime.consumer_checkpoint TO kavaroutes_realtime;
GRANT EXECUTE ON FUNCTION platform.current_tenant_id() TO kavaroutes_realtime;

COMMIT;
