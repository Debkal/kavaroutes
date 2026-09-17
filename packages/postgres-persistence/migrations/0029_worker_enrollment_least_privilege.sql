BEGIN;
SET LOCAL ROLE kavaroutes_migration;

-- Least privilege for the worker enrollment registry.
--
-- 0027 created platform.worker_enrollment and granted the worker and outbox
-- consumer roles direct SELECT on it, on top of the bounded SECURITY DEFINER
-- reader platform.enrolled_tenants(integer). Every reader in the repository uses
-- the bounded function (infra/gcp/runtime/worker.mjs builds the tenant reader in
-- packages/postgres-persistence/src/worker-enrollment.ts, whose only query is
-- SELECT platform.enrolled_tenants($1)); nothing reads the table directly, and
-- infra/gcp/runtime/database.mjs no longer re-grants it at boot. The direct grant
-- was nevertheless broader than the code needs: it let a worker or consumer bug
-- enumerate every enrolled tenant without the 1..100 LIMIT, the ordering or the
-- argument validation that the function enforces. Removing it leaves the bounded
-- path intact because a SECURITY DEFINER function runs with its owner's rights,
-- so the caller only needs EXECUTE.
--
-- The table keeps no policy and no RLS on purpose: it is a global registry of
-- opaque tenant identifiers, not tenant-owned data, and the API role was never
-- granted direct access to it. Only the owner (this migration role) may read or
-- write rows.
REVOKE SELECT ON platform.worker_enrollment FROM kavaroutes_worker, kavaroutes_outbox_consumer;

COMMIT;
