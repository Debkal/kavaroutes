BEGIN;
SET LOCAL ROLE kavaroutes_migration;

-- Device (browser/phone) positioning for the live driver map. Three additive pieces:
--   1. the batch receipt is bound to the shift it belongs to, so a dispatch trace can be
--      read for one shift instead of guessing by driver and time window;
--   2. breadcrumbs keep the reported accuracy so the map can say how precise a fix is;
--   3. monthly breadcrumb partitions exist for the months this system will actually run
--      in (the original set stopped at 2026-11-01, which would reject every later sample).
ALTER TABLE realtime.location_batch_receipt ADD COLUMN shift_id uuid;
CREATE INDEX location_batch_receipt_shift_idx ON realtime.location_batch_receipt (tenant_id, shift_id, received_at DESC);

ALTER TABLE realtime.location_breadcrumb ADD COLUMN accuracy_meters double precision;
ALTER TABLE realtime.location_breadcrumb ADD CONSTRAINT location_breadcrumb_accuracy_check
  CHECK (accuracy_meters IS NULL OR (accuracy_meters >= 0 AND accuracy_meters <= 100000));

CREATE TABLE realtime.location_breadcrumb_2026_11 PARTITION OF realtime.location_breadcrumb FOR VALUES FROM ('2026-11-01') TO ('2026-12-01');
CREATE TABLE realtime.location_breadcrumb_2026_12 PARTITION OF realtime.location_breadcrumb FOR VALUES FROM ('2026-12-01') TO ('2027-01-01');
CREATE TABLE realtime.location_breadcrumb_2027_01 PARTITION OF realtime.location_breadcrumb FOR VALUES FROM ('2027-01-01') TO ('2027-02-01');
CREATE TABLE realtime.location_breadcrumb_2027_02 PARTITION OF realtime.location_breadcrumb FOR VALUES FROM ('2027-02-01') TO ('2027-03-01');
CREATE TABLE realtime.location_breadcrumb_2027_03 PARTITION OF realtime.location_breadcrumb FOR VALUES FROM ('2027-03-01') TO ('2027-04-01');
CREATE TABLE realtime.location_breadcrumb_2027_04 PARTITION OF realtime.location_breadcrumb FOR VALUES FROM ('2027-04-01') TO ('2027-05-01');
CREATE TABLE realtime.location_breadcrumb_2027_05 PARTITION OF realtime.location_breadcrumb FOR VALUES FROM ('2027-05-01') TO ('2027-06-01');
CREATE TABLE realtime.location_breadcrumb_2027_06 PARTITION OF realtime.location_breadcrumb FOR VALUES FROM ('2027-06-01') TO ('2027-07-01');

COMMIT;
