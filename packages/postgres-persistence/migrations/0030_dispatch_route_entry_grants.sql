BEGIN;
SET LOCAL ROLE kavaroutes_migration;

-- Two tables a dispatcher-authored run must write, and neither had an api grant.
--
-- 0017/0018 tightened `dispatch` to least privilege: the assignment path only
-- reads `dispatch.run_service_requirements`, so it kept SELECT, and
-- `execution.driver_leg_proof_rule` (0016) was written by the seeded prototype
-- packet under the api role only because the seed ran before those grants were
-- narrowed. `planDispatchRun` now creates both rows in the same transaction as
-- the run, the leg and the execution, so the api role needs INSERT on them.
--
-- INSERT only, deliberately. There is still no UPDATE or DELETE grant: a
-- persisted requirement or proof rule is append-only, and changing either stays
-- an administrator (migration role) action rather than a dispatch command.
GRANT INSERT ON dispatch.run_service_requirements TO kavaroutes_api;
GRANT INSERT ON execution.driver_leg_proof_rule TO kavaroutes_api;

COMMIT;
