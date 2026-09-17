BEGIN;
SET LOCAL ROLE kavaroutes_migration;

-- Audit WEB-A-020 asked for the intended scope of the signature anti-replay rule to be
-- stated where the rule lives. The rule is deliberately tenant-wide: one stroke digest
-- can be stored once for the whole tenant, in any year, on any leg. That is benign for a
-- handwritten mark and hostile to any deterministic signature source, so the scope is
-- documented rather than silently narrowed. Narrowing it (for example to
-- (tenant, execution_id, stroke_digest)) is a product decision that would need its own
-- migration and a re-verification of the audit's duplicate-stroke cases.
COMMENT ON INDEX execution.driver_service_proof_tenant_id_stroke_digest_key IS
  'Tenant-wide signature anti-replay: a stroke digest can be stored once per tenant, across all legs, shifts and service dates. Deterministic signature sources must vary their strokes. See web_audit.md WEB-A-020.';

COMMIT;
