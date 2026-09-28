BEGIN;
SET LOCAL ROLE kavaroutes_migration;

-- Metadata only: no URLs, API keys, coordinates, request bodies or responses.
CREATE TABLE audit.external_api_request (
  tenant_id uuid NOT NULL REFERENCES platform.organization(tenant_id),
  id uuid NOT NULL,
  occurred_at timestamptz NOT NULL,
  provider text NOT NULL CHECK (length(provider) BETWEEN 1 AND 32),
  operation text NOT NULL CHECK (length(operation) BETWEEN 1 AND 64),
  feature text NOT NULL CHECK (length(feature) BETWEEN 1 AND 32),
  http_status smallint NOT NULL CHECK (http_status BETWEEN 0 AND 599),
  duration_ms integer NOT NULL CHECK (duration_ms BETWEEN 0 AND 60000),
  PRIMARY KEY (tenant_id,id)
);
CREATE INDEX external_api_request_recent ON audit.external_api_request(tenant_id,occurred_at DESC);
ALTER TABLE audit.external_api_request ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit.external_api_request FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON audit.external_api_request
  USING (tenant_id = platform.current_tenant_id())
  WITH CHECK (tenant_id = platform.current_tenant_id());
REVOKE ALL ON audit.external_api_request FROM PUBLIC;
GRANT SELECT,INSERT,DELETE ON audit.external_api_request TO kavaroutes_api;

RESET ROLE;
COMMIT;
