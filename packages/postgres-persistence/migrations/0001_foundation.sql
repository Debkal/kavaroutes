BEGIN;

SET LOCAL timezone = 'UTC';

CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS btree_gist;
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;

DO $roles$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kavaroutes_migration') THEN
    CREATE ROLE kavaroutes_migration NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kavaroutes_api') THEN
    CREATE ROLE kavaroutes_api NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kavaroutes_worker') THEN
    CREATE ROLE kavaroutes_worker NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kavaroutes_import') THEN
    CREATE ROLE kavaroutes_import NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;
END
$roles$;

DO $legacy$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'wp005_test') THEN
    IF NOT EXISTS (
      SELECT 1
      FROM information_schema.tables
      WHERE table_schema = 'wp005_test' AND table_name = 'synthetic_probe'
    ) THEN
      RAISE EXCEPTION 'WP005_UPGRADE_SHAPE_UNRECOGNIZED';
    END IF;
    DROP SCHEMA wp005_test CASCADE;
  END IF;
END
$legacy$;

CREATE SCHEMA IF NOT EXISTS platform AUTHORIZATION kavaroutes_migration;
CREATE SCHEMA IF NOT EXISTS intake AUTHORIZATION kavaroutes_migration;
CREATE SCHEMA IF NOT EXISTS fleet AUTHORIZATION kavaroutes_migration;
CREATE SCHEMA IF NOT EXISTS dispatch AUTHORIZATION kavaroutes_migration;
CREATE SCHEMA IF NOT EXISTS execution AUTHORIZATION kavaroutes_migration;
CREATE SCHEMA IF NOT EXISTS realtime AUTHORIZATION kavaroutes_migration;
CREATE SCHEMA IF NOT EXISTS billing AUTHORIZATION kavaroutes_migration;
CREATE SCHEMA IF NOT EXISTS integration AUTHORIZATION kavaroutes_migration;
CREATE SCHEMA IF NOT EXISTS audit AUTHORIZATION kavaroutes_migration;

SET LOCAL ROLE kavaroutes_migration;

CREATE OR REPLACE FUNCTION platform.current_tenant_id()
RETURNS uuid
LANGUAGE sql
STABLE
PARALLEL SAFE
AS $function$
  SELECT CASE
    WHEN current_setting('app.tenant_id', true) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    THEN current_setting('app.tenant_id', true)::uuid
    ELSE NULL::uuid
  END
$function$;

CREATE OR REPLACE FUNCTION platform.is_valid_timezone(zone_name text)
RETURNS boolean
LANGUAGE sql
STABLE
PARALLEL SAFE
AS $function$
  SELECT EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = zone_name)
$function$;

CREATE OR REPLACE FUNCTION platform.resolve_civil_instant(
  local_value timestamp without time zone,
  zone_name text,
  ambiguity_policy text
)
RETURNS timestamptz
LANGUAGE plpgsql
STABLE
AS $function$
DECLARE
  candidate timestamptz;
  candidate_count integer;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = zone_name) THEN
    RAISE EXCEPTION 'INVALID_IANA_TIMEZONE' USING ERRCODE = '22023';
  END IF;
  IF ambiguity_policy NOT IN ('reject', 'earlier', 'later') THEN
    RAISE EXCEPTION 'INVALID_AMBIGUITY_POLICY' USING ERRCODE = '22023';
  END IF;

  SELECT count(*),
         CASE ambiguity_policy
           WHEN 'later' THEN max(value)
           ELSE min(value)
         END
    INTO candidate_count, candidate
  FROM (
    SELECT instant AS value
    FROM generate_series(
      (local_value AT TIME ZONE zone_name) - interval '3 hours',
      (local_value AT TIME ZONE zone_name) + interval '3 hours',
      interval '1 minute'
    ) AS instant
    WHERE instant AT TIME ZONE zone_name = local_value
  ) matches;

  IF candidate_count = 0 THEN
    RAISE EXCEPTION 'NONEXISTENT_CIVIL_TIME' USING ERRCODE = '22008';
  END IF;
  IF candidate_count > 1 AND ambiguity_policy = 'reject' THEN
    RAISE EXCEPTION 'AMBIGUOUS_CIVIL_TIME' USING ERRCODE = '22008';
  END IF;
  RETURN candidate;
END
$function$;

RESET ROLE;
COMMIT;
