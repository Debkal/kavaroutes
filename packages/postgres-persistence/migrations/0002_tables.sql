BEGIN;

SET LOCAL timezone = 'UTC';
SET LOCAL ROLE kavaroutes_migration;

CREATE TABLE platform.organization (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL,
  synthetic_name text NOT NULL,
  aggregate_version bigint NOT NULL DEFAULT 1 CHECK (aggregate_version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id),
  CHECK (tenant_id = id)
);

CREATE TABLE platform.branch (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL,
  organization_id uuid NOT NULL,
  synthetic_label text NOT NULL,
  aggregate_version bigint NOT NULL DEFAULT 1 CHECK (aggregate_version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, organization_id) REFERENCES platform.organization (tenant_id, id)
);

CREATE TABLE platform.idempotency_record (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL,
  operation_key text NOT NULL,
  request_fingerprint text NOT NULL,
  result_reference text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, operation_key)
);

CREATE TABLE intake.address (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL,
  customer_label text NOT NULL,
  operational_point geography(Point, 4326),
  provider_reference text,
  provider_cache_expires_at timestamptz,
  provider_provenance text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  CHECK (operational_point IS NULL OR (ST_SRID(operational_point::geometry) = 4326 AND ST_IsValid(operational_point::geometry) AND NOT ST_IsEmpty(operational_point::geometry)))
);

CREATE TABLE intake.facility (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL,
  address_id uuid NOT NULL,
  synthetic_label text NOT NULL,
  aggregate_version bigint NOT NULL DEFAULT 1 CHECK (aggregate_version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, address_id) REFERENCES intake.address (tenant_id, id)
);

CREATE TABLE intake.service_area (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL,
  synthetic_label text NOT NULL,
  boundary geometry(MultiPolygon, 4326) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  CHECK (ST_SRID(boundary) = 4326 AND ST_IsValid(boundary) AND NOT ST_IsEmpty(boundary))
);

CREATE TABLE intake.rider (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL,
  home_address_id uuid,
  synthetic_reference text NOT NULL,
  aggregate_version bigint NOT NULL DEFAULT 1 CHECK (aggregate_version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, synthetic_reference),
  FOREIGN KEY (tenant_id, home_address_id) REFERENCES intake.address (tenant_id, id)
);

CREATE TABLE intake.trip_request (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL,
  rider_id uuid NOT NULL,
  service_date date NOT NULL,
  service_timezone text NOT NULL CHECK (platform.is_valid_timezone(service_timezone)),
  local_service_time time without time zone NOT NULL,
  resolved_service_at timestamptz NOT NULL,
  resolved_utc_offset_seconds integer NOT NULL CHECK (resolved_utc_offset_seconds BETWEEN -50400 AND 50400),
  ambiguity_policy text NOT NULL CHECK (ambiguity_policy IN ('reject', 'earlier', 'later')),
  ambiguity_policy_version text NOT NULL,
  aggregate_version bigint NOT NULL DEFAULT 1 CHECK (aggregate_version > 0),
  lifecycle_reference text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, rider_id) REFERENCES intake.rider (tenant_id, id)
);

CREATE TABLE intake.trip_leg (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL,
  trip_request_id uuid NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal > 0),
  origin_address_id uuid NOT NULL,
  destination_address_id uuid NOT NULL,
  planned_start_at timestamptz NOT NULL,
  planned_end_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, trip_request_id, ordinal),
  FOREIGN KEY (tenant_id, trip_request_id) REFERENCES intake.trip_request (tenant_id, id),
  FOREIGN KEY (tenant_id, origin_address_id) REFERENCES intake.address (tenant_id, id),
  FOREIGN KEY (tenant_id, destination_address_id) REFERENCES intake.address (tenant_id, id),
  CHECK (planned_start_at < planned_end_at)
);

CREATE TABLE intake.authorization (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL,
  rider_id uuid NOT NULL,
  authorization_reference text NOT NULL,
  valid_during daterange NOT NULL,
  aggregate_version bigint NOT NULL DEFAULT 1 CHECK (aggregate_version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, authorization_reference),
  FOREIGN KEY (tenant_id, rider_id) REFERENCES intake.rider (tenant_id, id)
);

CREATE TABLE fleet.driver (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL,
  synthetic_reference text NOT NULL,
  aggregate_version bigint NOT NULL DEFAULT 1 CHECK (aggregate_version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, synthetic_reference)
);

CREATE TABLE fleet.vehicle (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL,
  synthetic_reference text NOT NULL,
  aggregate_version bigint NOT NULL DEFAULT 1 CHECK (aggregate_version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, synthetic_reference)
);

CREATE TABLE fleet.qualification (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL,
  driver_id uuid,
  vehicle_id uuid,
  qualification_kind text NOT NULL,
  valid_during daterange NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, driver_id) REFERENCES fleet.driver (tenant_id, id),
  FOREIGN KEY (tenant_id, vehicle_id) REFERENCES fleet.vehicle (tenant_id, id),
  CHECK ((driver_id IS NOT NULL) <> (vehicle_id IS NOT NULL))
);

CREATE TABLE dispatch.run (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL,
  branch_id uuid NOT NULL,
  service_date date NOT NULL,
  service_timezone text NOT NULL CHECK (platform.is_valid_timezone(service_timezone)),
  planned_start_at timestamptz NOT NULL,
  planned_end_at timestamptz NOT NULL,
  lifecycle_reference text NOT NULL,
  aggregate_version bigint NOT NULL DEFAULT 1 CHECK (aggregate_version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, branch_id) REFERENCES platform.branch (tenant_id, id),
  CHECK (planned_start_at < planned_end_at)
);

CREATE TABLE dispatch.run_leg (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL,
  run_id uuid NOT NULL,
  trip_leg_id uuid NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, run_id, ordinal),
  UNIQUE (tenant_id, run_id, trip_leg_id),
  FOREIGN KEY (tenant_id, run_id) REFERENCES dispatch.run (tenant_id, id),
  FOREIGN KEY (tenant_id, trip_leg_id) REFERENCES intake.trip_leg (tenant_id, id)
);

CREATE TABLE dispatch.assignment (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL,
  run_id uuid NOT NULL,
  driver_id uuid,
  vehicle_id uuid,
  aggregate_version bigint NOT NULL DEFAULT 1 CHECK (aggregate_version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, run_id) REFERENCES dispatch.run (tenant_id, id),
  FOREIGN KEY (tenant_id, driver_id) REFERENCES fleet.driver (tenant_id, id),
  FOREIGN KEY (tenant_id, vehicle_id) REFERENCES fleet.vehicle (tenant_id, id),
  CHECK (driver_id IS NOT NULL OR vehicle_id IS NOT NULL)
);

CREATE TABLE dispatch.resource_reservation (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL,
  run_id uuid NOT NULL,
  resource_kind text NOT NULL CHECK (resource_kind IN ('driver', 'vehicle')),
  resource_id uuid NOT NULL,
  occupied_during tstzrange NOT NULL,
  cancelled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, run_id) REFERENCES dispatch.run (tenant_id, id),
  CHECK (NOT isempty(occupied_during) AND lower_inc(occupied_during) AND NOT upper_inc(occupied_during))
);

CREATE TABLE execution.leg_execution (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL,
  trip_leg_id uuid NOT NULL,
  run_id uuid,
  lifecycle_reference text NOT NULL,
  aggregate_version bigint NOT NULL DEFAULT 1 CHECK (aggregate_version > 0),
  occurred_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, trip_leg_id) REFERENCES intake.trip_leg (tenant_id, id),
  FOREIGN KEY (tenant_id, run_id) REFERENCES dispatch.run (tenant_id, id)
);

CREATE TABLE execution.evidence_record (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL,
  leg_execution_id uuid NOT NULL,
  aggregate_version bigint NOT NULL DEFAULT 1 CHECK (aggregate_version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, leg_execution_id) REFERENCES execution.leg_execution (tenant_id, id) ON DELETE RESTRICT
);

CREATE TABLE execution.evidence_revision (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL,
  evidence_record_id uuid NOT NULL,
  revision_number integer NOT NULL CHECK (revision_number > 0),
  supersedes_revision_id uuid,
  evidence_reference text NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, evidence_record_id, revision_number),
  FOREIGN KEY (tenant_id, evidence_record_id) REFERENCES execution.evidence_record (tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, supersedes_revision_id) REFERENCES execution.evidence_revision (tenant_id, id) ON DELETE RESTRICT
);

CREATE TABLE realtime.location_batch_receipt (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL,
  device_id uuid NOT NULL,
  request_fingerprint text NOT NULL,
  sample_count integer NOT NULL CHECK (sample_count >= 0),
  received_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, device_id, request_fingerprint)
);

CREATE TABLE realtime.current_position (
  tenant_id uuid NOT NULL,
  subject_kind text NOT NULL CHECK (subject_kind IN ('driver', 'vehicle')),
  subject_id uuid NOT NULL,
  device_id uuid NOT NULL,
  stream_epoch bigint NOT NULL CHECK (stream_epoch >= 0),
  sequence_number bigint NOT NULL CHECK (sequence_number >= 0),
  captured_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  position geography(Point, 4326) NOT NULL,
  source_batch_id uuid,
  PRIMARY KEY (tenant_id, subject_kind, subject_id, device_id),
  FOREIGN KEY (tenant_id, source_batch_id) REFERENCES realtime.location_batch_receipt (tenant_id, id),
  CHECK (ST_SRID(position::geometry) = 4326 AND ST_IsValid(position::geometry) AND NOT ST_IsEmpty(position::geometry))
);

CREATE TABLE realtime.location_breadcrumb (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL,
  batch_id uuid NOT NULL,
  sample_index integer NOT NULL CHECK (sample_index >= 0),
  subject_kind text NOT NULL CHECK (subject_kind IN ('driver', 'vehicle')),
  subject_id uuid NOT NULL,
  device_id uuid NOT NULL,
  stream_epoch bigint NOT NULL CHECK (stream_epoch >= 0),
  sequence_number bigint NOT NULL CHECK (sequence_number >= 0),
  captured_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  retention_due_at timestamptz NOT NULL,
  retention_policy_version text NOT NULL,
  legal_hold boolean NOT NULL DEFAULT false,
  position geography(Point, 4326) NOT NULL,
  PRIMARY KEY (tenant_id, id, recorded_at),
  UNIQUE (tenant_id, batch_id, sample_index, recorded_at),
  FOREIGN KEY (tenant_id, batch_id) REFERENCES realtime.location_batch_receipt (tenant_id, id),
  CHECK (retention_due_at >= recorded_at),
  CHECK (ST_SRID(position::geometry) = 4326 AND ST_IsValid(position::geometry) AND NOT ST_IsEmpty(position::geometry))
) PARTITION BY RANGE (recorded_at);

CREATE TABLE realtime.location_breadcrumb_2026_06 PARTITION OF realtime.location_breadcrumb FOR VALUES FROM ('2026-06-01') TO ('2026-07-01');
CREATE TABLE realtime.location_breadcrumb_2026_07 PARTITION OF realtime.location_breadcrumb FOR VALUES FROM ('2026-07-01') TO ('2026-08-01');
CREATE TABLE realtime.location_breadcrumb_2026_08 PARTITION OF realtime.location_breadcrumb FOR VALUES FROM ('2026-08-01') TO ('2026-09-01');
CREATE TABLE realtime.location_breadcrumb_2026_09 PARTITION OF realtime.location_breadcrumb FOR VALUES FROM ('2026-09-01') TO ('2026-10-01');
CREATE TABLE realtime.location_breadcrumb_2026_10 PARTITION OF realtime.location_breadcrumb FOR VALUES FROM ('2026-10-01') TO ('2026-11-01');
CREATE TABLE realtime.location_breadcrumb_default PARTITION OF realtime.location_breadcrumb DEFAULT;

CREATE TABLE realtime.retention_quarantine (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL,
  partition_name text NOT NULL,
  policy_version text NOT NULL,
  eligible_rows bigint NOT NULL CHECK (eligible_rows >= 0),
  held_rows bigint NOT NULL CHECK (held_rows >= 0),
  planned_at timestamptz NOT NULL DEFAULT now(),
  reconciled_at timestamptz,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, partition_name, policy_version)
);

CREATE TABLE billing.billing_case (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL,
  trip_request_id uuid NOT NULL,
  lifecycle_reference text NOT NULL,
  aggregate_version bigint NOT NULL DEFAULT 1 CHECK (aggregate_version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, trip_request_id) REFERENCES intake.trip_request (tenant_id, id) ON DELETE RESTRICT
);

CREATE TABLE billing.invoice_history (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL,
  billing_case_id uuid NOT NULL,
  revision_number integer NOT NULL CHECK (revision_number > 0),
  transition_reference text NOT NULL,
  occurred_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, billing_case_id, revision_number),
  FOREIGN KEY (tenant_id, billing_case_id) REFERENCES billing.billing_case (tenant_id, id) ON DELETE RESTRICT
);

CREATE TABLE billing.claim_history (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL,
  billing_case_id uuid NOT NULL,
  revision_number integer NOT NULL CHECK (revision_number > 0),
  transition_reference text NOT NULL,
  occurred_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, billing_case_id, revision_number),
  FOREIGN KEY (tenant_id, billing_case_id) REFERENCES billing.billing_case (tenant_id, id) ON DELETE RESTRICT
);

CREATE TABLE billing.financial_transition (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL,
  billing_case_id uuid NOT NULL,
  transition_reference text NOT NULL,
  amount_minor bigint NOT NULL,
  currency_code text NOT NULL CHECK (currency_code ~ '^[A-Z]{3}$'),
  occurred_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, billing_case_id) REFERENCES billing.billing_case (tenant_id, id) ON DELETE RESTRICT
);

CREATE TABLE integration.receipt (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL,
  source_reference text NOT NULL,
  request_fingerprint text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, source_reference)
);

CREATE TABLE integration.item (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL,
  receipt_id uuid NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  outcome_reference text,
  processed_at timestamptz,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, receipt_id, ordinal),
  FOREIGN KEY (tenant_id, receipt_id) REFERENCES integration.receipt (tenant_id, id) ON DELETE RESTRICT
);

CREATE TABLE audit.event (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL,
  aggregate_kind text NOT NULL,
  aggregate_id uuid NOT NULL,
  aggregate_version bigint NOT NULL CHECK (aggregate_version > 0),
  action_reference text NOT NULL,
  actor_reference text NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, aggregate_kind, aggregate_id, aggregate_version, action_reference)
);

RESET ROLE;
COMMIT;
