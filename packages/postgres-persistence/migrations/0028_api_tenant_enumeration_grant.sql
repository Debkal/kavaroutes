BEGIN;
SET LOCAL ROLE kavaroutes_migration;

-- The guarded API host sweeps provider-account revocation across the enrolled
-- tenant set. The reader stays bounded (a maximum of 100 tenants, ordered) and
-- read-only: the API role may call it, and only the enrollment registry owner
-- writes it. The bound is enforced inside the function as well as by callers.
GRANT EXECUTE ON FUNCTION platform.enrolled_tenants(integer) TO kavaroutes_api;
COMMIT;
