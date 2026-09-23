BEGIN;
SET LOCAL ROLE kavaroutes_migration;
ALTER TABLE billing.route_cost_profile
 ADD COLUMN vehicle_count integer NOT NULL DEFAULT 1 CHECK (vehicle_count BETWEEN 1 AND 10000),
 ADD COLUMN expected_monthly_trips integer NOT NULL DEFAULT 167 CHECK (expected_monthly_trips BETWEEN 1 AND 1000000),
 ADD COLUMN annual_fixed_costs_cents integer NOT NULL DEFAULT 0 CHECK (annual_fixed_costs_cents BETWEEN 0 AND 2000000000),
 ADD COLUMN use_historical_volume boolean NOT NULL DEFAULT false;
COMMIT;
