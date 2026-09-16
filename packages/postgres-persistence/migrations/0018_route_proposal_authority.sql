BEGIN;
SET LOCAL ROLE kavaroutes_migration;
-- Planning facts are administrator/scheduler resolved, never submitted by Driver.
CREATE TABLE dispatch.route_planning_facts (
 tenant_id uuid NOT NULL,run_id uuid NOT NULL,version bigint NOT NULL CHECK(version>0),
 nodes jsonb NOT NULL CHECK(jsonb_typeof(nodes)='array'),
 feasibility jsonb NOT NULL CHECK(jsonb_typeof(feasibility)='object'),
 PRIMARY KEY(tenant_id,run_id),FOREIGN KEY(tenant_id,run_id) REFERENCES dispatch.run(tenant_id,id)
);
CREATE TABLE dispatch.route_proposal (
 tenant_id uuid NOT NULL,id uuid NOT NULL,shift_id uuid NOT NULL,assignment_id uuid NOT NULL,run_id uuid NOT NULL,
 proposer_id uuid NOT NULL,shift_generation uuid NOT NULL,policy_digest text NOT NULL CHECK(policy_digest~'^[a-f0-9]{64}$'),
 run_version bigint NOT NULL CHECK(run_version>0),facts_version bigint NOT NULL CHECK(facts_version>0),
 proposed_order jsonb NOT NULL CHECK(jsonb_typeof(proposed_order)='array'),
 approval_mode text NOT NULL CHECK(approval_mode IN('AUTHORIZED_SELF_APPROVE','DISPATCH_APPROVAL_REQUIRED')),
 recorded_at timestamptz NOT NULL DEFAULT now(),expires_at timestamptz NOT NULL,
 PRIMARY KEY(tenant_id,id),FOREIGN KEY(tenant_id,shift_id) REFERENCES execution.shift_policy_snapshot(tenant_id,id),
 FOREIGN KEY(tenant_id,assignment_id) REFERENCES dispatch.assignment(tenant_id,id),
 FOREIGN KEY(tenant_id,run_id) REFERENCES dispatch.run(tenant_id,id),CHECK(expires_at>recorded_at)
);
CREATE TABLE dispatch.route_proposal_decision (
 tenant_id uuid NOT NULL,proposal_id uuid NOT NULL,decision text NOT NULL CHECK(decision IN('APPROVED','REJECTED','EXPIRED','CONFLICT')),
 actor_id uuid NOT NULL,reason_code text NOT NULL CHECK(reason_code IN('VALIDATED_SELF_APPROVAL','DISPATCH_APPROVED','DISPATCH_REJECTED','STATE_CHANGED','EXPIRED')),
 committed_run_version bigint,recorded_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,proposal_id),FOREIGN KEY(tenant_id,proposal_id) REFERENCES dispatch.route_proposal(tenant_id,id),
 CHECK((decision='APPROVED')=(committed_run_version IS NOT NULL))
);
CREATE TABLE dispatch.route_revision (
 tenant_id uuid NOT NULL,run_id uuid NOT NULL,run_version bigint NOT NULL,proposal_id uuid NOT NULL,
 node_order jsonb NOT NULL CHECK(jsonb_typeof(node_order)='array'),schedule jsonb NOT NULL CHECK(jsonb_typeof(schedule)='array'),
 recorded_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(tenant_id,run_id,run_version),UNIQUE(tenant_id,proposal_id),
 FOREIGN KEY(tenant_id,run_id) REFERENCES dispatch.run(tenant_id,id),
 FOREIGN KEY(tenant_id,proposal_id) REFERENCES dispatch.route_proposal(tenant_id,id)
);
DO $fn$
DECLARE tbl text;
BEGIN
 FOREACH tbl IN ARRAY ARRAY['route_planning_facts','route_proposal','route_proposal_decision','route_revision'] LOOP
  EXECUTE format('ALTER TABLE dispatch.%I ENABLE ROW LEVEL SECURITY',tbl);
  EXECUTE format('ALTER TABLE dispatch.%I FORCE ROW LEVEL SECURITY',tbl);
  EXECUTE format('CREATE POLICY tenant_isolation ON dispatch.%I USING(tenant_id=platform.current_tenant_id()) WITH CHECK(tenant_id=platform.current_tenant_id())',tbl);
  EXECUTE format('REVOKE ALL ON dispatch.%I FROM PUBLIC',tbl);
  EXECUTE format('GRANT SELECT ON dispatch.%I TO kavaroutes_api',tbl);
  IF tbl<>'route_planning_facts' THEN
   EXECUTE format('GRANT INSERT ON dispatch.%I TO kavaroutes_api',tbl);
   EXECUTE format('CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON dispatch.%I FOR EACH ROW EXECUTE FUNCTION execution.reject_driver_action_receipt_mutation()',tbl);
  END IF;
 END LOOP;
END $fn$;
GRANT SELECT(tenant_id,id,run_id) ON dispatch.route_proposal TO kavaroutes_outbox_consumer;
COMMIT;
