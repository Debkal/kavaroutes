BEGIN;
SET LOCAL ROLE kavaroutes_migration;

-- Store only the dispatcher's optimization goal. Google route geometry and turn
-- instructions are generated on demand and are never retained in PostgreSQL.
CREATE TABLE dispatch.selected_road_route (
  tenant_id uuid NOT NULL,
  trip_leg_id uuid NOT NULL,
  goal text NOT NULL CHECK (goal IN ('LOW_COST','FASTEST','EASIEST')),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  selected_by uuid NOT NULL,
  selected_at timestamptz NOT NULL DEFAULT now(),
  command_key text NOT NULL CHECK (length(command_key) BETWEEN 1 AND 200),
  PRIMARY KEY (tenant_id, trip_leg_id),
  FOREIGN KEY (tenant_id, trip_leg_id) REFERENCES intake.trip_leg (tenant_id, id) ON DELETE RESTRICT
);

ALTER TABLE dispatch.selected_road_route ENABLE ROW LEVEL SECURITY;
ALTER TABLE dispatch.selected_road_route FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON dispatch.selected_road_route
  USING (tenant_id = platform.current_tenant_id())
  WITH CHECK (tenant_id = platform.current_tenant_id());
REVOKE ALL ON dispatch.selected_road_route FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON dispatch.selected_road_route TO kavaroutes_api;
GRANT SELECT ON dispatch.selected_road_route TO kavaroutes_worker;

RESET ROLE;
COMMIT;
