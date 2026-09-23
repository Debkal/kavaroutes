BEGIN;
SET LOCAL ROLE kavaroutes_migration;
ALTER TABLE billing.route_cost_profile ADD COLUMN included_business_insurance text[]
 CHECK (included_business_insurance <@ ARRAY['workersCompAnnualCents','generalLiabilityAnnualCents','umbrellaAnnualCents','professionalLiabilityAnnualCents','cyberInsuranceAnnualCents','otherInsuranceAnnualCents']::text[] AND cardinality(included_business_insurance)<=6);
COMMIT;
