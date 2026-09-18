BEGIN;
SET LOCAL ROLE kavaroutes_migration;

-- Route costing. Every amount is in cents so an estimate never drifts on floating point,
-- and every rate is an input the operator enters from their own quotes: the research
-- ranges live in the interface as defaults, not here as business rules.
CREATE TABLE billing.route_cost_profile (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL,
  fuel_cents_per_gallon integer NOT NULL CHECK (fuel_cents_per_gallon BETWEEN 1 AND 5000),
  fuel_efficiency_mpg numeric(5,2) NOT NULL CHECK (fuel_efficiency_mpg BETWEEN 1 AND 60),
  maintenance_cents_per_mile integer NOT NULL CHECK (maintenance_cents_per_mile BETWEEN 0 AND 1000),
  driver_hourly_cents integer NOT NULL CHECK (driver_hourly_cents BETWEEN 0 AND 20000),
  driver_burden_percent numeric(5,2) NOT NULL CHECK (driver_burden_percent BETWEEN 0 AND 100),
  insurance_cents_per_month_per_vehicle integer NOT NULL CHECK (insurance_cents_per_month_per_vehicle BETWEEN 0 AND 500000),
  fixed_overhead_cents_per_month integer NOT NULL CHECK (fixed_overhead_cents_per_month BETWEEN 0 AND 5000000),
  deadhead_percent numeric(5,2) NOT NULL CHECK (deadhead_percent BETWEEN 0 AND 100),
  target_margin_percent numeric(5,2) NOT NULL CHECK (target_margin_percent BETWEEN 0 AND 90),
  contracted_base_cents integer NOT NULL DEFAULT 0 CHECK (contracted_base_cents BETWEEN 0 AND 1000000),
  contracted_cents_per_mile integer NOT NULL DEFAULT 0 CHECK (contracted_cents_per_mile BETWEEN 0 AND 100000),
  average_trip_miles numeric(6,2) NOT NULL DEFAULT 12 CHECK (average_trip_miles BETWEEN 0.5 AND 500),
  loaded_miles_per_hour numeric(5,2) NOT NULL DEFAULT 20 CHECK (loaded_miles_per_hour BETWEEN 1 AND 80),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id)
);

-- One invoice per payer period. The lines are the trips it bills, copied at creation so a
-- later trip edit cannot silently change what was sent.
CREATE TABLE billing.payer_invoice (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL,
  client_id uuid,
  payer_kind text NOT NULL CHECK (payer_kind IN ('MEDICAID','BROKER','MCO','COMMERCIAL_INSURANCE','WORKERS_COMPENSATION','AUTO_LIABILITY','FACILITY','PATIENT','OTHER')),
  payer_name text NOT NULL CHECK (length(payer_name) BETWEEN 1 AND 200),
  claim_reference text CHECK (claim_reference IS NULL OR length(claim_reference) BETWEEN 1 AND 64),
  period_start date NOT NULL,
  period_end date NOT NULL,
  status text NOT NULL CHECK (status IN ('DRAFT','READY','SENT','PAID','VOID')),
  total_cents integer NOT NULL CHECK (total_cents >= 0),
  total_miles numeric(10,2) NOT NULL CHECK (total_miles >= 0),
  forwarded_at timestamptz,
  forwarded_method text CHECK (forwarded_method IS NULL OR forwarded_method IN ('EXPORT','EMAIL','PORTAL','POST')),
  forwarded_to text CHECK (forwarded_to IS NULL OR length(forwarded_to) BETWEEN 1 AND 200),
  paid_at timestamptz,
  aggregate_version bigint NOT NULL DEFAULT 1 CHECK (aggregate_version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  CHECK (period_end >= period_start),
  CHECK ((forwarded_at IS NULL) = (forwarded_method IS NULL)),
  FOREIGN KEY (tenant_id, client_id) REFERENCES intake.facility (tenant_id, id) ON DELETE RESTRICT
);

CREATE TABLE billing.payer_invoice_line (
  tenant_id uuid NOT NULL,
  invoice_id uuid NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal BETWEEN 1 AND 500),
  trip_id uuid NOT NULL,
  service_date date NOT NULL,
  description text NOT NULL CHECK (length(description) BETWEEN 1 AND 300),
  miles numeric(8,2) NOT NULL CHECK (miles >= 0),
  hcpcs_code text CHECK (hcpcs_code IS NULL OR hcpcs_code ~ '^[A-Z][0-9]{4}$'),
  authorization_number text CHECK (authorization_number IS NULL OR length(authorization_number) BETWEEN 1 AND 64),
  proof_of_service text NOT NULL CHECK (proof_of_service IN ('SIGNATURE_ON_FILE','FACILITY_SIGNATURE','DRIVER_ATTESTED','NOT_REQUIRED','MISSING')),
  amount_cents integer NOT NULL CHECK (amount_cents >= 0),
  PRIMARY KEY (tenant_id, invoice_id, ordinal),
  UNIQUE (tenant_id, invoice_id, trip_id),
  FOREIGN KEY (tenant_id, invoice_id) REFERENCES billing.payer_invoice (tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, trip_id) REFERENCES intake.trip_request (tenant_id, id) ON DELETE RESTRICT
);

CREATE TABLE billing.payer_invoice_event (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL,
  invoice_id uuid NOT NULL,
  aggregate_version bigint NOT NULL CHECK (aggregate_version > 0),
  action_reference text NOT NULL CHECK (action_reference IN ('CREATED','FORWARDED','PAID','VOIDED')),
  actor_reference text NOT NULL CHECK (length(actor_reference) BETWEEN 1 AND 200),
  detail text CHECK (detail IS NULL OR length(detail) BETWEEN 1 AND 200),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, invoice_id, aggregate_version),
  FOREIGN KEY (tenant_id, invoice_id) REFERENCES billing.payer_invoice (tenant_id, id) ON DELETE RESTRICT
);

ALTER TABLE billing.route_cost_profile ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing.route_cost_profile FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON billing.route_cost_profile
  USING (tenant_id = platform.current_tenant_id()) WITH CHECK (tenant_id = platform.current_tenant_id());
ALTER TABLE billing.payer_invoice ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing.payer_invoice FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON billing.payer_invoice
  USING (tenant_id = platform.current_tenant_id()) WITH CHECK (tenant_id = platform.current_tenant_id());
ALTER TABLE billing.payer_invoice_line ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing.payer_invoice_line FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON billing.payer_invoice_line
  USING (tenant_id = platform.current_tenant_id()) WITH CHECK (tenant_id = platform.current_tenant_id());
ALTER TABLE billing.payer_invoice_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing.payer_invoice_event FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON billing.payer_invoice_event
  USING (tenant_id = platform.current_tenant_id()) WITH CHECK (tenant_id = platform.current_tenant_id());

REVOKE ALL ON billing.route_cost_profile, billing.payer_invoice, billing.payer_invoice_line, billing.payer_invoice_event FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON billing.route_cost_profile, billing.payer_invoice, billing.payer_invoice_line, billing.payer_invoice_event TO kavaroutes_api;
GRANT SELECT ON billing.route_cost_profile, billing.payer_invoice, billing.payer_invoice_line, billing.payer_invoice_event TO kavaroutes_worker;

RESET ROLE;
COMMIT;
