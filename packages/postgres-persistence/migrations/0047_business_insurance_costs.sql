BEGIN;
SET LOCAL ROLE kavaroutes_migration;
ALTER TABLE billing.route_cost_profile
 ADD COLUMN workers_comp_annual_cents integer NOT NULL DEFAULT 0 CHECK (workers_comp_annual_cents BETWEEN 0 AND 2000000000),
 ADD COLUMN general_liability_annual_cents integer NOT NULL DEFAULT 0 CHECK (general_liability_annual_cents BETWEEN 0 AND 2000000000),
 ADD COLUMN umbrella_annual_cents integer NOT NULL DEFAULT 0 CHECK (umbrella_annual_cents BETWEEN 0 AND 2000000000),
 ADD COLUMN professional_liability_annual_cents integer NOT NULL DEFAULT 0 CHECK (professional_liability_annual_cents BETWEEN 0 AND 2000000000),
 ADD COLUMN cyber_insurance_annual_cents integer NOT NULL DEFAULT 0 CHECK (cyber_insurance_annual_cents BETWEEN 0 AND 2000000000),
 ADD COLUMN other_insurance_annual_cents integer NOT NULL DEFAULT 0 CHECK (other_insurance_annual_cents BETWEEN 0 AND 2000000000);
COMMIT;
