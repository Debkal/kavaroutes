BEGIN;
CREATE TABLE outbox.consumer_transport_journal (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL,
  delivery_id uuid NOT NULL,
  transport_id uuid NOT NULL,
  transport_attempt integer NOT NULL CHECK (transport_attempt >= 0),
  action text NOT NULL CHECK (action IN ('RETRY','DEAD_LETTER','REPLAY')),
  safe_code text NOT NULL CHECK (safe_code IN ('TRANSIENT_DEPENDENCY','DATABASE_CONCURRENCY','PERMANENT_VALIDATION','RETRY_EXHAUSTED','OPERATOR_REVIEWED')),
  actor_reference text NOT NULL CHECK (actor_reference ~ '^[a-z][a-z0-9._:-]{2,95}$'),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  retain_until timestamptz NOT NULL DEFAULT (now() + interval '30 days'),
  PRIMARY KEY (tenant_id,id),
  UNIQUE (tenant_id,transport_id,transport_attempt,action),
  FOREIGN KEY (tenant_id,delivery_id) REFERENCES outbox.delivery(tenant_id,id) ON DELETE RESTRICT,
  CHECK (retain_until >= occurred_at + interval '30 days')
);
ALTER TABLE outbox.consumer_transport_journal ENABLE ROW LEVEL SECURITY;
ALTER TABLE outbox.consumer_transport_journal FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON outbox.consumer_transport_journal
  USING (tenant_id = platform.current_tenant_id()) WITH CHECK (tenant_id = platform.current_tenant_id());
REVOKE ALL ON outbox.consumer_transport_journal FROM PUBLIC;
GRANT SELECT,INSERT ON outbox.consumer_transport_journal TO kavaroutes_outbox_consumer;
CREATE TRIGGER immutable_consumer_transport_journal BEFORE UPDATE OR DELETE ON outbox.consumer_transport_journal
  FOR EACH ROW EXECUTE FUNCTION outbox.reject_immutable_mutation();
CREATE INDEX consumer_transport_journal_delivery ON outbox.consumer_transport_journal(tenant_id,delivery_id,occurred_at);
COMMIT;
