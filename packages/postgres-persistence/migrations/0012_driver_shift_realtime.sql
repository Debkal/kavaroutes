BEGIN;

SET LOCAL ROLE kavaroutes_migration;

-- The realtime consumer resolves only a shift snapshot's service day. RLS remains forced.
GRANT USAGE ON SCHEMA execution, dispatch TO kavaroutes_outbox_consumer;
GRANT SELECT (tenant_id,id,assignment_id) ON execution.shift_policy_snapshot TO kavaroutes_outbox_consumer;
GRANT SELECT (tenant_id,id,run_id) ON dispatch.assignment TO kavaroutes_outbox_consumer;
GRANT SELECT (tenant_id,id,service_date) ON dispatch.run TO kavaroutes_outbox_consumer;

RESET ROLE;

COMMIT;
