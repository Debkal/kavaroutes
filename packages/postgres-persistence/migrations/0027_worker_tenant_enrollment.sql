BEGIN;
SET LOCAL ROLE kavaroutes_migration;

-- Explicit worker enrollment registry. Worker processing is bounded and
-- authorized: a tenant is processed only after an operator enrolls it here, and
-- the registry holds opaque identifiers only. Rows are written by administrative
-- provisioning, never by the API or by the worker itself.
CREATE TABLE platform.worker_enrollment (
 tenant_id uuid PRIMARY KEY,
 enrolled boolean NOT NULL DEFAULT true,
 enrolled_at timestamptz NOT NULL DEFAULT now()
);
REVOKE ALL ON platform.worker_enrollment FROM PUBLIC;
GRANT SELECT ON platform.worker_enrollment TO kavaroutes_worker, kavaroutes_outbox_consumer;

-- The retained synthetic development tenant keeps its current behaviour.
INSERT INTO platform.worker_enrollment(tenant_id) VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
 ON CONFLICT (tenant_id) DO NOTHING;

-- Bounded reader so a host can never enumerate an unbounded tenant set. The
-- bound is enforced inside the function as well as by the caller.
CREATE FUNCTION platform.enrolled_tenants(maximum integer) RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, platform AS $$
 SELECT tenant_id FROM platform.worker_enrollment
  WHERE enrolled AND maximum BETWEEN 1 AND 100
  ORDER BY tenant_id LIMIT maximum
$$;
REVOKE ALL ON FUNCTION platform.enrolled_tenants(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform.enrolled_tenants(integer) TO kavaroutes_worker, kavaroutes_outbox_consumer;
COMMIT;
