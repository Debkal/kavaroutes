BEGIN;
SET LOCAL ROLE kavaroutes_migration;
CREATE TABLE execution.driver_tracking_alert (
 tenant_id uuid NOT NULL,shift_id uuid NOT NULL,version bigint NOT NULL CHECK(version>0),
 status text NOT NULL CHECK(status IN('SHIFT_ENDED','STATUS_UNAVAILABLE','TRACKING_STOPPED','NO_UPDATES','WAITING_FOR_FIRST_UPDATE','UPDATES_OVERDUE','UPDATES_CURRENT')),
 reason text NOT NULL,contact_driver boolean NOT NULL,evaluated_at timestamptz NOT NULL,
 last_captured_at timestamptz,last_received_at timestamptz,
 PRIMARY KEY(tenant_id,shift_id),FOREIGN KEY(tenant_id,shift_id) REFERENCES execution.shift_policy_snapshot(tenant_id,id)
);
CREATE TABLE execution.driver_tracking_alert_event (LIKE execution.driver_tracking_alert INCLUDING DEFAULTS INCLUDING CONSTRAINTS);
ALTER TABLE execution.driver_tracking_alert_event ADD PRIMARY KEY(tenant_id,shift_id,version),ADD FOREIGN KEY(tenant_id,shift_id) REFERENCES execution.shift_policy_snapshot(tenant_id,id);
DO $fn$
DECLARE tbl text;
BEGIN
 FOREACH tbl IN ARRAY ARRAY['driver_tracking_alert','driver_tracking_alert_event'] LOOP
  EXECUTE format('ALTER TABLE execution.%I ENABLE ROW LEVEL SECURITY',tbl);
  EXECUTE format('ALTER TABLE execution.%I FORCE ROW LEVEL SECURITY',tbl);
  EXECUTE format('CREATE POLICY tenant_isolation ON execution.%I USING(tenant_id=platform.current_tenant_id()) WITH CHECK(tenant_id=platform.current_tenant_id())',tbl);
  EXECUTE format('REVOKE ALL ON execution.%I FROM PUBLIC',tbl);
  EXECUTE format('GRANT SELECT ON execution.%I TO kavaroutes_api',tbl);
  EXECUTE format('GRANT SELECT,INSERT ON execution.%I TO kavaroutes_outbox_consumer',tbl);
 END LOOP;
END $fn$;
GRANT UPDATE ON execution.driver_tracking_alert TO kavaroutes_outbox_consumer;
GRANT SELECT ON execution.shift_policy_snapshot,execution.driver_shift_closure TO kavaroutes_outbox_consumer;
CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON execution.driver_tracking_alert_event FOR EACH ROW EXECUTE FUNCTION execution.reject_driver_action_receipt_mutation();
COMMIT;
