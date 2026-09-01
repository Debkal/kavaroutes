import test from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  canonicalJson,
  evaluateFlow,
  normalizeBundle,
  productionReadiness,
  readJson,
  resolveClassifications,
  validateAssurance,
  validatePolicy
} from "../lib/contracts.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const classifications = await readJson(join(root, "catalog", "classifications.json"));
const policy = await readJson(join(root, "catalog", "policy-registry.json"));
const assurance = await readJson(join(root, "hipaa", "assurance-registry.json"));
const flows = await readJson(join(root, "flows", "synthetic-flows.json"));
const flow = (id) => structuredClone(flows.flows.find((item) => item.id === id));

test("normalized bundle is byte-equivalent for the same version and seed", () => {
  assert.equal(canonicalJson(normalizeBundle(classifications, policy, assurance, flows)), canonicalJson(normalizeBundle(structuredClone(classifications), structuredClone(policy), structuredClone(assurance), structuredClone(flows))));
});

test("all seven stable classifications are present", () => {
  assert.deepEqual(classifications.classifications.map((item) => item.id).sort(), ["FINANCIAL_RESTRICTED", "INTERNAL", "PERSONAL_CONFIDENTIAL", "PUBLIC", "REGULATED_HEALTH", "RESTRICTED_LOCATION", "SECRET"]);
});

test("classification joins add health and location controls", () => {
  assert.deepEqual(resolveClassifications({ direct: ["INTERNAL"], tags: ["rider-trip-context", "precise-location"] }, classifications), ["INTERNAL", "REGULATED_HEALTH", "RESTRICTED_LOCATION"]);
});

test("lower classification cannot erase inherited controls", () => {
  assert.throws(() => resolveClassifications({ inherited: ["REGULATED_HEALTH"], requestedRemove: ["REGULATED_HEALTH"] }, classifications), /cannot erase/);
});

test("unclassified fields fail closed", () => {
  const invalid = structuredClone(policy); invalid.fields[0].classifications = [];
  assert.throws(() => validatePolicy(invalid, classifications), /unclassified fields fail closed/);
});

test("unknown purposes and destinations fail closed", () => {
  const unknownPurpose = flow("FLOW_DISPATCHER_RIDER_INTAKE"); unknownPurpose.purpose = "UNKNOWN_PURPOSE";
  assert.throws(() => evaluateFlow(unknownPurpose, policy, assurance), /unknown purpose/);
  const unknownDestination = flow("FLOW_DISPATCHER_RIDER_INTAKE"); unknownDestination.destination = "UNKNOWN_DESTINATION";
  assert.throws(() => evaluateFlow(unknownDestination, policy, assurance), /unknown destination/);
});

test("missing tenant, retention, or policy version fails closed", () => {
  const noTenant = flow("FLOW_DISPATCHER_RIDER_INTAKE"); delete noTenant.tenantId;
  assert.throws(() => evaluateFlow(noTenant, policy, assurance), /tenantId/);
  const noRetention = flow("FLOW_DISPATCHER_RIDER_INTAKE"); noRetention.retentionClass = "UNKNOWN";
  assert.throws(() => evaluateFlow(noRetention, policy, assurance), /retention basis/);
  const stalePolicy = flow("FLOW_DISPATCHER_RIDER_INTAKE"); stalePolicy.policyVersion = "stale";
  assert.throws(() => evaluateFlow(stalePolicy, policy, assurance), /policy version/);
});

test("Maps allows only the route-guidance envelope", () => {
  const allowed = evaluateFlow(flow("FLOW_MAPS_ROUTE_GUIDANCE"), policy, assurance);
  assert.deepEqual(allowed, { decision: "ALLOW_SYNTHETIC_CONTRACT", reason: "MAPS_ROUTE_GUIDANCE_ALLOWLIST_ONLY" });
  const denied = flow("FLOW_MAPS_ROUTE_GUIDANCE"); denied.fieldIds.push("rider.identity");
  assert.deepEqual(evaluateFlow(denied, policy, assurance), { decision: "DENY", reason: "MAPS_NON_ALLOWLISTED_FIELD" });
});

test("observability rejects sensitive fields and every canary family", () => {
  const denied = evaluateFlow(flow("FLOW_OBSERVABILITY_CANARY_REJECT"), policy, assurance);
  assert.deepEqual(denied, { decision: "DENY", reason: "OBSERVABILITY_SENSITIVE_FIELD_REJECTED" });
  assert.deepEqual(new Set(policy.redactionCanaries.map((item) => item.kind)), new Set(["name", "address", "coordinates", "free_text", "identifier", "credential", "token"]));
});

test("role projections allow minimum assigned fields and deny excess or unassigned access", () => {
  assert.equal(evaluateFlow(flow("FLOW_DRIVER_ASSIGNED_MANIFEST"), policy, assurance).decision, "ALLOW_SYNTHETIC_CONTRACT");
  assert.deepEqual(evaluateFlow(flow("FLOW_DRIVER_UNASSIGNED_RIDER"), policy, assurance), { decision: "DENY", reason: "DRIVER_NOT_ASSIGNED" });
  const excess = flow("FLOW_DRIVER_ASSIGNED_MANIFEST"); excess.fieldIds.push("payer.claimId");
  assert.deepEqual(evaluateFlow(excess, policy, assurance), { decision: "DENY", reason: "FIELD_POLICY_DENIED" });
});

test("facility and billing projections deny excess location", () => {
  assert.equal(evaluateFlow(flow("FLOW_FACILITY_RELATED_TRIP"), policy, assurance).decision, "ALLOW_SYNTHETIC_CONTRACT");
  assert.equal(evaluateFlow(flow("FLOW_FACILITY_FLEET_LOCATION"), policy, assurance).decision, "DENY");
  assert.equal(evaluateFlow(flow("FLOW_BILLING_CONTINUOUS_BREADCRUMBS"), policy, assurance).reason, "ADDITIONAL_LOCATION_PURPOSE_REQUIRED");
});

test("cross-tenant references and grants fail closed", () => {
  assert.deepEqual(evaluateFlow(flow("FLOW_CROSS_TENANT_POLICY_GRANT"), policy, assurance), { decision: "DENY", reason: "CROSS_TENANT_REFERENCE" });
  const invalid = flow("FLOW_DRIVER_ASSIGNED_MANIFEST"); invalid.relationship.assignmentTenantId = "syn_tenant_beta";
  assert.equal(evaluateFlow(invalid, policy, assurance).reason, "CROSS_TENANT_REFERENCE");
});

test("security and assurance decisions preserve explicit fail-closed precedence", () => {
  const cases = [
    ["cross-tenant before revoked workforce", (item) => { item.referencedTenantId = "syn_tenant_beta"; item.actor = "SYNTHETIC_TERMINATED_ACTOR_ALPHA"; }, "CROSS_TENANT_REFERENCE"],
    ["revoked workforce before forbidden claim", (item) => { item.actor = "SYNTHETIC_TERMINATED_ACTOR_ALPHA"; item.claim = "HIPAA_CERTIFIED"; }, "WORKFORCE_ACCESS_REVOKED"],
    ["forbidden claim before applicability", (item) => { item.claim = "HIPAA_CERTIFIED"; item.applicabilityId = "APP_RIDER_INTAKE"; }, "FORBIDDEN_COMPLIANCE_OR_CERTIFICATION_CLAIM"],
    ["applicability before critical risk", (item) => { item.applicabilityId = "APP_RIDER_INTAKE"; item.riskIds = ["RISK_CRITICAL_UNTREATED"]; }, "HIPAA_ROLE_UNDETERMINED"],
    ["critical risk before stale evaluation", (item) => { item.riskIds = ["RISK_CRITICAL_UNTREATED"]; item.evaluationId = "EVAL_STALE_SYNTHETIC"; }, "CRITICAL_RISK_UNTREATED"],
    ["stale evaluation before incident", (item) => { item.evaluationId = "EVAL_STALE_SYNTHETIC"; item.incidentId = "INC_POTENTIAL_DISCLOSURE"; }, "EVALUATION_STALE_OR_MATERIAL_CHANGE"],
    ["incident before contingency", (item) => { item.incidentId = "INC_POTENTIAL_DISCLOSURE"; item.contingencyId = "CONT_RESTORE_UNRESOLVED"; }, "QUALIFIED_BREACH_DETERMINATION_REQUIRED"],
    ["contingency before deletion", (item) => { item.contingencyId = "CONT_RESTORE_UNRESOLVED"; item.deletion = { legalHold: true, completionReported: false, destinations: [] }; }, "RESTORE_OR_DELETION_RECONCILIATION_INCOMPLETE"],
    ["deletion before vendor", (item) => { item.deletion = { legalHold: true, completionReported: false, destinations: [] }; item.vendorId = "VENDOR_CATEGORY_ONLY"; }, "LEGAL_HOLD_PRECEDENCE"],
    ["vendor before role projection", (item) => { item.vendorId = "VENDOR_CATEGORY_ONLY"; item.role = "DRIVER"; item.relationship = { assigned: false }; }, "EXACT_SERVICE_VENDOR_RECORD_MISSING"],
    ["role projection before special purpose", (item) => { item.role = "DRIVER"; item.relationship = { assigned: false }; item.purpose = "MAPS_ROUTE_GUIDANCE"; }, "DRIVER_NOT_ASSIGNED"]
  ];
  for (const [name, mutate, reason] of cases) {
    const item = flow("FLOW_DISPATCHER_RIDER_INTAKE");
    mutate(item);
    assert.equal(evaluateFlow(item, policy, assurance).reason, reason, name);
  }
});

test("retention requires explicit duration, legal-hold precedence, and verification", () => {
  const invalid = structuredClone(policy); delete invalid.retentionPolicies[0].duration;
  assert.throws(() => validatePolicy(invalid, classifications), /duration/);
  const noHold = structuredClone(policy); noHold.retentionPolicies[0].holdPrecedence = false;
  assert.throws(() => validatePolicy(noHold, classifications), /legal hold/);
});

test("deletion cannot complete with hold or unresolved destination", () => {
  assert.deepEqual(evaluateFlow(flow("FLOW_DELETION_LEGAL_HOLD"), policy, assurance), { decision: "BLOCKED", reason: "LEGAL_HOLD_PRECEDENCE" });
  const invalid = flow("FLOW_DELETION_LEGAL_HOLD"); invalid.deletion.legalHold = false; invalid.deletion.completionReported = true;
  assert.deepEqual(evaluateFlow(invalid, policy, assurance), { decision: "DENY", reason: "DELETION_DESTINATION_UNRESOLVED" });
});

test("ADDRESSABLE control cannot omit assessment and rationale", () => {
  const invalid = structuredClone(assurance);
  const control = invalid.controls.find((item) => item.designation.startsWith("ADDRESSABLE")); delete control.addressableAssessment;
  assert.throws(() => validateAssurance(invalid, policy), /ADDRESSABLE/);
});

test("controls fail closed without owner, evidence expectation, or official source", () => {
  const noOwner = structuredClone(assurance); delete noOwner.controls[0].ownerRole;
  assert.throws(() => validateAssurance(noOwner, policy), /ownerRole/);
  const noEvidence = structuredClone(assurance); noEvidence.controls[0].evidenceExpectations = [];
  assert.throws(() => validateAssurance(noEvidence, policy), /evidenceExpectations/);
  const noSource = structuredClone(assurance); noSource.controls[0].sourceIds = [];
  assert.throws(() => validateAssurance(noSource, policy), /official source required/);
});

test("remediation actions fail closed without accountable owners", () => {
  const invalid = structuredClone(assurance); delete invalid.incidents[0].correctiveActions[0].ownerRole;
  assert.throws(() => validateAssurance(invalid, policy), /ownerRole/);
});

test("missing or non-service-specific vendor evidence blocks regulated processing", () => {
  assert.deepEqual(evaluateFlow(flow("FLOW_VENDOR_MISSING_BAA"), policy, assurance), { decision: "BLOCKED", reason: "EXACT_SERVICE_BAA_OR_APPROVAL_MISSING" });
  const missing = flow("FLOW_VENDOR_MISSING_BAA"); missing.vendorId = "VENDOR_CATEGORY_ONLY";
  assert.deepEqual(evaluateFlow(missing, policy, assurance), { decision: "BLOCKED", reason: "EXACT_SERVICE_VENDOR_RECORD_MISSING" });
});

test("critical risk, stale evaluation, incident, and restore gaps block readiness", () => {
  assert.equal(evaluateFlow(flow("FLOW_CRITICAL_RISK_READINESS"), policy, assurance).reason, "CRITICAL_RISK_UNTREATED");
  assert.equal(evaluateFlow(flow("FLOW_STALE_EVALUATION"), policy, assurance).reason, "EVALUATION_STALE_OR_MATERIAL_CHANGE");
  assert.equal(evaluateFlow(flow("FLOW_POTENTIAL_BREACH_TRIAGE"), policy, assurance).reason, "QUALIFIED_BREACH_DETERMINATION_REQUIRED");
  assert.equal(evaluateFlow(flow("FLOW_RESTORE_VALIDATION"), policy, assurance).reason, "RESTORE_OR_DELETION_RECONCILIATION_INCOMPLETE");
});

test("potential breach contract cannot contain automated legal determination", () => {
  const invalid = structuredClone(assurance); invalid.incidents[0].legalDetermination = "BREACH";
  assert.throws(() => validateAssurance(invalid, policy), /must not automate/);
});

test("terminated workforce access and expired break-glass access are denied", () => {
  assert.equal(evaluateFlow(flow("FLOW_TERMINATED_WORKER_ACCESS"), policy, assurance).reason, "WORKFORCE_ACCESS_REVOKED");
  const expired = flow("FLOW_SUPPORT_BREAK_GLASS"); expired.evaluationTime = "2026-08-24T02:00:00Z";
  assert.equal(evaluateFlow(expired, policy, assurance).reason, "BREAK_GLASS_REQUIREMENTS_MISSING_OR_EXPIRED");
});

test("undetermined applicability blocks and qualified example only enables further review", () => {
  assert.equal(evaluateFlow(flow("FLOW_APPLICABILITY_UNDETERMINED"), policy, assurance).reason, "HIPAA_ROLE_UNDETERMINED");
  assert.deepEqual(evaluateFlow(flow("FLOW_APPLICABILITY_QUALIFIED_EXAMPLE"), policy, assurance), { decision: "ELIGIBLE_FOR_FURTHER_REVIEW", reason: "QUALIFIED_APPLICABILITY_REPRESENTED_NOT_PRODUCTION_APPROVAL" });
});

test("forbidden compliance and certification claims are rejected", () => {
  for (const claim of ["HIPAA_CERTIFIED", "SELF_CERTIFIED_HIPAA", "CERTIFICATE_AS_BAA", "SOC2_AS_HIPAA", "HITRUST_AS_HIPAA", "ASSESSMENT_AS_PRODUCTION_APPROVAL"]) {
    const item = flow("FLOW_MISLEADING_CERTIFICATION"); item.claim = claim;
    assert.deepEqual(evaluateFlow(item, policy, assurance), { decision: "DENY", reason: "FORBIDDEN_COMPLIANCE_OR_CERTIFICATION_CLAIM" });
  }
});

test("assurance history cannot hide prior records", () => {
  const invalid = structuredClone(assurance); invalid.controls[0].immutableHistory = false;
  assert.throws(() => validateAssurance(invalid, policy), /history must be immutable/);
  assert.equal(assurance.workforce.policyVersions[1].supersedes, assurance.workforce.policyVersions[0].id);
});

test("production PHI readiness remains blocked without legal conclusion", () => {
  const readiness = productionReadiness(assurance);
  assert.equal(readiness.status, "BLOCKED_NOT_PRODUCTION_PHI_READY");
  assert.equal(readiness.legalComplianceDetermination, null);
  assert.ok(readiness.blockers.includes("HIPAA_ROLE_UNDETERMINED"));
  assert.ok(readiness.blockers.includes("CRITICAL_RISK_UNTREATED"));
});
