BEGIN;

SET LOCAL timezone = 'UTC';
SET LOCAL ROLE kavaroutes_migration;

ALTER TABLE dispatch.resource_reservation
  ADD CONSTRAINT resource_reservation_no_overlap
  EXCLUDE USING gist (
    tenant_id WITH =,
    resource_kind WITH =,
    resource_id WITH =,
    occupied_during WITH &&
  ) WHERE (cancelled_at IS NULL);

CREATE INDEX address_operational_point_gist ON intake.address USING gist (tenant_id, operational_point);
CREATE INDEX service_area_boundary_gist ON intake.service_area USING gist (tenant_id, boundary);
CREATE INDEX trip_request_service_day_idx ON intake.trip_request (tenant_id, service_date, resolved_service_at);
CREATE INDEX trip_leg_planned_start_idx ON intake.trip_leg (tenant_id, planned_start_at, trip_request_id);
CREATE INDEX driver_reference_idx ON fleet.driver (tenant_id, synthetic_reference);
CREATE INDEX vehicle_reference_idx ON fleet.vehicle (tenant_id, synthetic_reference);
CREATE INDEX run_dispatch_board_idx ON dispatch.run (tenant_id, service_date, planned_start_at);
CREATE INDEX run_leg_manifest_idx ON dispatch.run_leg (tenant_id, run_id, ordinal);
CREATE INDEX assignment_run_idx ON dispatch.assignment (tenant_id, run_id);
CREATE INDEX current_position_location_gist ON realtime.current_position USING gist (tenant_id, position);
CREATE INDEX current_position_recent_idx ON realtime.current_position (tenant_id, subject_kind, subject_id, device_id, captured_at DESC);
CREATE INDEX breadcrumb_device_capture_idx ON realtime.location_breadcrumb (tenant_id, device_id, captured_at DESC);
CREATE INDEX breadcrumb_recorded_brin_idx ON realtime.location_breadcrumb USING brin (recorded_at) WITH (pages_per_range = 32);
CREATE INDEX billing_case_ready_idx ON billing.billing_case (tenant_id, lifecycle_reference, created_at);
CREATE INDEX audit_aggregate_history_idx ON audit.event (tenant_id, aggregate_kind, aggregate_id, aggregate_version);
CREATE INDEX integration_item_receipt_idx ON integration.item (tenant_id, receipt_id, ordinal);

CREATE OR REPLACE FUNCTION realtime.advance_current_position(
  p_tenant_id uuid,
  p_subject_kind text,
  p_subject_id uuid,
  p_device_id uuid,
  p_stream_epoch bigint,
  p_sequence_number bigint,
  p_captured_at timestamptz,
  p_recorded_at timestamptz,
  p_longitude double precision,
  p_latitude double precision,
  p_source_batch_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
AS $function$
DECLARE
  changed_count integer;
BEGIN
  IF p_tenant_id IS DISTINCT FROM platform.current_tenant_id() THEN
    RAISE EXCEPTION 'TENANT_CONTEXT_MISMATCH' USING ERRCODE = '42501';
  END IF;
  IF p_longitude NOT BETWEEN -180 AND 180 OR p_latitude NOT BETWEEN -90 AND 90 THEN
    RAISE EXCEPTION 'INVALID_POSITION' USING ERRCODE = '22023';
  END IF;

  INSERT INTO realtime.current_position (
    tenant_id, subject_kind, subject_id, device_id, stream_epoch, sequence_number,
    captured_at, recorded_at, position, source_batch_id
  ) VALUES (
    p_tenant_id, p_subject_kind, p_subject_id, p_device_id, p_stream_epoch, p_sequence_number,
    p_captured_at, p_recorded_at, ST_SetSRID(ST_MakePoint(p_longitude, p_latitude), 4326)::geography, p_source_batch_id
  )
  ON CONFLICT (tenant_id, subject_kind, subject_id, device_id) DO UPDATE
    SET stream_epoch = EXCLUDED.stream_epoch,
        sequence_number = EXCLUDED.sequence_number,
        captured_at = EXCLUDED.captured_at,
        recorded_at = EXCLUDED.recorded_at,
        position = EXCLUDED.position,
        source_batch_id = EXCLUDED.source_batch_id
  WHERE (EXCLUDED.stream_epoch, EXCLUDED.sequence_number, EXCLUDED.captured_at)
      > (current_position.stream_epoch, current_position.sequence_number, current_position.captured_at);

  GET DIAGNOSTICS changed_count = ROW_COUNT;
  RETURN changed_count = 1;
END
$function$;

CREATE OR REPLACE FUNCTION realtime.plan_breadcrumb_retention(
  p_as_of timestamptz,
  p_policy_version text DEFAULT 'raw-location-30d-v1'
)
RETURNS TABLE (
  partition_name text,
  eligible_rows bigint,
  held_rows bigint,
  minimum_due_at timestamptz,
  dry_run boolean
)
LANGUAGE sql
STABLE
AS $function$
  SELECT tableoid::regclass::text,
         count(*) FILTER (WHERE retention_due_at <= p_as_of AND NOT legal_hold),
         count(*) FILTER (WHERE retention_due_at <= p_as_of AND legal_hold),
         min(retention_due_at),
         true
  FROM realtime.location_breadcrumb
  WHERE tenant_id = platform.current_tenant_id()
    AND retention_policy_version = p_policy_version
    AND retention_due_at <= p_as_of
  GROUP BY tableoid
  ORDER BY tableoid::regclass::text
$function$;

DO $rls$
DECLARE
  item record;
BEGIN
  FOR item IN
    SELECT n.nspname AS schema_name, c.relname AS table_name
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname IN ('platform', 'intake', 'fleet', 'dispatch', 'execution', 'realtime', 'billing', 'integration', 'audit')
      AND c.relkind IN ('r', 'p')
      AND NOT c.relispartition
  LOOP
    EXECUTE format('ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY', item.schema_name, item.table_name);
    EXECUTE format('ALTER TABLE %I.%I FORCE ROW LEVEL SECURITY', item.schema_name, item.table_name);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I.%I USING (tenant_id = platform.current_tenant_id()) WITH CHECK (tenant_id = platform.current_tenant_id())',
      item.schema_name, item.table_name
    );
  END LOOP;
END
$rls$;

CREATE OR REPLACE FUNCTION platform.assert_tenant_boundaries()
RETURNS void
LANGUAGE plpgsql
AS $function$
DECLARE
  violation text;
BEGIN
  SELECT string_agg(problem, E'\n' ORDER BY problem)
  INTO violation
  FROM (
    SELECT format('%I.%I: missing immutable tenant_id', n.nspname, c.relname) AS problem
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    LEFT JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped
    WHERE n.nspname IN ('platform', 'intake', 'fleet', 'dispatch', 'execution', 'realtime', 'billing', 'integration', 'audit')
      AND c.relkind IN ('r', 'p') AND NOT c.relispartition
      AND (a.attname IS NULL OR NOT a.attnotnull)
    UNION ALL
    SELECT format('%I.%I: tenant_id is not first in %s constraint %I', n.nspname, c.relname, con.contype, con.conname)
    FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname IN ('platform', 'intake', 'fleet', 'dispatch', 'execution', 'realtime', 'billing', 'integration', 'audit')
      AND con.contype IN ('p', 'u', 'f')
      AND (SELECT a.attname FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attnum = con.conkey[1]) IS DISTINCT FROM 'tenant_id'
    UNION ALL
    SELECT format('%I.%I: tenant_id is not first in index %I', n.nspname, c.relname, i.relname)
    FROM pg_index x
    JOIN pg_class c ON c.oid = x.indrelid
    JOIN pg_class i ON i.oid = x.indexrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_am am ON am.oid = i.relam
    WHERE n.nspname IN ('platform', 'intake', 'fleet', 'dispatch', 'execution', 'realtime', 'billing', 'integration', 'audit')
      AND NOT c.relispartition
      AND am.amname <> 'brin'
      AND (SELECT a.attname FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attnum = x.indkey[0]) IS DISTINCT FROM 'tenant_id'
    UNION ALL
    SELECT format('%I.%I: RLS is not enabled and forced', n.nspname, c.relname)
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname IN ('platform', 'intake', 'fleet', 'dispatch', 'execution', 'realtime', 'billing', 'integration', 'audit')
      AND c.relkind IN ('r', 'p') AND NOT c.relispartition
      AND (NOT c.relrowsecurity OR NOT c.relforcerowsecurity)
  ) failures;

  IF violation IS NOT NULL THEN
    RAISE EXCEPTION 'TENANT_BOUNDARY_AUDIT_FAILED:%', E'\n' || violation;
  END IF;
END
$function$;

SELECT platform.assert_tenant_boundaries();

RESET ROLE;

REVOKE ALL ON SCHEMA public FROM PUBLIC;
REVOKE ALL ON SCHEMA platform, intake, fleet, dispatch, execution, realtime, billing, integration, audit FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA platform, intake, fleet, dispatch, execution, realtime, billing, integration, audit FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA platform, intake, fleet, dispatch, execution, realtime, billing, integration, audit FROM PUBLIC;
GRANT USAGE ON SCHEMA platform, intake, fleet, dispatch, execution, realtime, billing, integration, audit TO kavaroutes_api, kavaroutes_worker;
GRANT USAGE ON SCHEMA platform, intake, integration, audit TO kavaroutes_import;
GRANT USAGE ON SCHEMA public TO kavaroutes_api, kavaroutes_worker, kavaroutes_import;
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA platform, intake, fleet, dispatch, execution, realtime, billing, integration, audit TO kavaroutes_api;
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA platform, intake, fleet, dispatch, execution, realtime, billing, integration, audit TO kavaroutes_worker;
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA intake, integration, audit TO kavaroutes_import;
GRANT EXECUTE ON FUNCTION platform.current_tenant_id() TO kavaroutes_api, kavaroutes_worker, kavaroutes_import;
GRANT EXECUTE ON FUNCTION platform.is_valid_timezone(text) TO kavaroutes_api, kavaroutes_worker, kavaroutes_import;
GRANT EXECUTE ON FUNCTION platform.resolve_civil_instant(timestamp without time zone, text, text) TO kavaroutes_api, kavaroutes_worker, kavaroutes_import;
GRANT EXECUTE ON FUNCTION realtime.advance_current_position(uuid, text, uuid, uuid, bigint, bigint, timestamptz, timestamptz, double precision, double precision, uuid) TO kavaroutes_api, kavaroutes_worker;
GRANT EXECUTE ON FUNCTION realtime.plan_breadcrumb_retention(timestamptz, text) TO kavaroutes_api, kavaroutes_worker;

ALTER DEFAULT PRIVILEGES FOR ROLE kavaroutes_migration REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE kavaroutes_migration REVOKE ALL ON FUNCTIONS FROM PUBLIC;

COMMIT;
