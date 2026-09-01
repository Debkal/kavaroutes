import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const CLASS_IDS = ["PUBLIC", "INTERNAL", "PERSONAL_CONFIDENTIAL", "RESTRICTED_LOCATION", "REGULATED_HEALTH", "FINANCIAL_RESTRICTED", "SECRET"];
const APPLICABILITY = ["UNDETERMINED", "OUTSIDE_HIPAA", "COVERED_ENTITY", "BUSINESS_ASSOCIATE", "BUSINESS_ASSOCIATE_SUBCONTRACTOR"];
const EVIDENCE_STATES = ["PLANNED", "COLLECTED", "REVIEWED", "FAILED", "EXPIRED", "QUALIFIED_APPROVAL"];
const ASSURANCE_TYPES = ["INTERNAL_EVALUATION", "INDEPENDENT_HIPAA_ASSESSMENT", "SOC_2", "HITRUST"];
const FORBIDDEN_CLAIMS = ["HIPAA_CERTIFIED", "SELF_CERTIFIED_HIPAA", "CERTIFICATE_AS_BAA", "SOC2_AS_HIPAA", "HITRUST_AS_HIPAA", "ASSESSMENT_AS_PRODUCTION_APPROVAL"];

function fail(path, message) { throw new Error(`${path}: ${message}`); }
function object(value, path) { if (!value || typeof value !== "object" || Array.isArray(value)) fail(path, "must be an object"); }
function string(value, path) { if (typeof value !== "string" || !value.trim()) fail(path, "must be a non-empty string"); }
function array(value, path) { if (!Array.isArray(value)) fail(path, "must be an array"); }
function unique(items, key, path) {
  const seen = new Set();
  for (const [index, item] of items.entries()) {
    const value = typeof key === "function" ? key(item) : item[key];
    string(value, `${path}[${index}]`);
    if (seen.has(value)) fail(`${path}[${index}]`, `duplicate identifier ${value}`);
    seen.add(value);
  }
}
function mapBy(items, key = "id") { return new Map(items.map((item) => [item[key], item])); }

export function canonicalJson(value) {
  const sort = (item) => Array.isArray(item) ? item.map(sort) : item && typeof item === "object"
    ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, sort(item[key])])) : item;
  return `${JSON.stringify(sort(value), null, 2)}\n`;
}

export function digest(value) { return createHash("sha256").update(canonicalJson(value)).digest("hex"); }
export async function readJson(path) { return JSON.parse(await readFile(path, "utf8")); }

export function resolveClassifications({ direct = [], inherited = [], tags = [], requestedRemove = [] }, classifications) {
  const known = new Set(classifications.classifications.map((item) => item.id));
  for (const id of [...direct, ...inherited, ...requestedRemove]) if (!known.has(id)) fail("classification", `unknown classification ${id}`);
  if (requestedRemove.length) fail("classification.requestedRemove", "a lower classification cannot erase inherited or direct controls");
  const effective = new Set([...direct, ...inherited]);
  for (const rule of classifications.escalationRules) {
    const all = rule.whenAll?.every((tag) => tags.includes(tag));
    const any = rule.whenAny?.some((tag) => tags.includes(tag));
    if (all || any) rule.add.forEach((id) => effective.add(id));
  }
  return [...effective].sort();
}

export function validateClassifications(registry) {
  object(registry, "classifications");
  if (registry.schemaVersion !== "1.0.0") fail("classifications.schemaVersion", "must be 1.0.0");
  array(registry.classifications, "classifications.classifications");
  unique(registry.classifications, "id", "classifications.classifications");
  const ids = registry.classifications.map((item) => item.id).sort();
  if (canonicalJson(ids) !== canonicalJson([...CLASS_IDS].sort())) fail("classifications.classifications", "must contain exactly the seven ARQ-002 classes");
  for (const [index, item] of registry.classifications.entries()) {
    string(item.description, `classifications.classifications[${index}].description`);
    if (!Array.isArray(item.handlingRules) || !item.handlingRules.length) fail(`classifications.classifications[${index}].handlingRules`, "must not be empty");
  }
  array(registry.escalationRules, "classifications.escalationRules");
  for (const rule of registry.escalationRules) for (const id of rule.add) if (!CLASS_IDS.includes(id)) fail(`classifications.escalationRules.${rule.id}`, `unknown class ${id}`);
  if (!registry.secretProhibition.includes("fixtures") || !registry.secretProhibition.includes("logs") || !registry.secretProhibition.includes("markdown")) fail("classifications.secretProhibition", "must prohibit secrets from fixtures, logs, and Markdown");
  return registry;
}

function validateRetentionPolicies(policies) {
  for (const [index, item] of policies.entries()) {
    const path = `policy.retentionPolicies[${index}]`;
    for (const key of ["effectiveDate", "scope", "basis", "trigger", "disposition", "backupAging", "verificationState", "approvalState"]) string(item[key], `${path}.${key}`);
    object(item.duration, `${path}.duration`);
    if (!(item.duration.value > 0) || !["day", "month", "year"].includes(item.duration.unit)) fail(`${path}.duration`, "must have positive value and explicit unit");
    if (item.holdPrecedence !== true) fail(`${path}.holdPrecedence`, "legal hold must take precedence");
    if (/global|universal/i.test(item.scope) && !/not-final|capability/i.test(item.scope)) fail(path, "unlabeled universal retention is forbidden");
  }
}

function validatePolicyFields(fields, classifications, references) {
  const classIds = new Set(CLASS_IDS);
  for (const [index, field] of fields.entries()) {
    const path = `policy.fields[${index}]`;
    for (const key of ["id", "subject", "retentionClass", "policyVersion", "approvalState", "approvalEvidenceRef"]) string(field[key], `${path}.${key}`);
    if (!field.classifications?.length) fail(`${path}.classifications`, "unclassified fields fail closed");
    for (const id of field.classifications) if (!classIds.has(id)) fail(`${path}.classifications`, `unknown classification ${id}`);
    if (!field.purposes?.length || field.purposes.some((id) => !references.purposes.has(id))) fail(`${path}.purposes`, "unknown or missing purpose");
    if (!field.roles?.length || field.roles.some((id) => !references.roles.has(id))) fail(`${path}.roles`, "unknown or missing role");
    if (!field.destinations?.length || field.destinations.some((id) => !references.destinations.has(id))) fail(`${path}.destinations`, "unknown or missing destination");
    if (!references.retention.has(field.retentionClass)) fail(`${path}.retentionClass`, "missing retention basis");
    const effective = resolveClassifications({ direct: field.classifications, tags: field.tags ?? [] }, classifications);
    for (const id of effective) if (!field.classifications.includes(id)) fail(`${path}.classifications`, `missing escalated classification ${id}`);
  }
}

function validateOfficialSources(sources) {
  for (const [index, source] of sources.entries()) {
    for (const key of ["id", "title", "url", "accessed", "authority"]) string(source[key], `policy.officialSources[${index}].${key}`);
  }
}

function validateRedactionCanaries(canaries) {
  const canaryKinds = new Set();
  for (const canary of canaries) {
    string(canary.kind, "policy.redactionCanaries.kind"); string(canary.value, "policy.redactionCanaries.value");
    if (!canary.value.startsWith("SYNTHETIC_") && !canary.value.startsWith("syn_")) fail("policy.redactionCanaries", "canaries must be conspicuously synthetic");
    if (/sk-[A-Za-z0-9]{12,}|AIza[A-Za-z0-9_-]{20,}/.test(canary.value)) fail("policy.redactionCanaries", "canary resembles a usable secret");
    canaryKinds.add(canary.kind);
  }
  for (const kind of ["name", "address", "coordinates", "free_text", "identifier", "credential", "token"]) {
    if (!canaryKinds.has(kind)) fail("policy.redactionCanaries", `missing ${kind} canary`);
  }
}

export function validatePolicy(policy, classifications) {
  object(policy, "policy");
  validateClassifications(classifications);
  if (policy.schemaVersion !== "1.0.0") fail("policy.schemaVersion", "must be 1.0.0");
  for (const key of ["purposes", "roles", "destinations", "retentionPolicies", "fields", "redactionCanaries", "officialSources"]) array(policy[key], `policy.${key}`);
  unique(policy.roles, "id", "policy.roles"); unique(policy.destinations, "id", "policy.destinations");
  unique(policy.retentionPolicies, "id", "policy.retentionPolicies"); unique(policy.fields, "id", "policy.fields");
  unique(policy.officialSources, "id", "policy.officialSources");
  const references = {
    purposes: new Set(policy.purposes),
    roles: new Set(policy.roles.map((item) => item.id)),
    destinations: new Set(policy.destinations.map((item) => item.id)),
    retention: new Set(policy.retentionPolicies.map((item) => item.id))
  };
  validateRetentionPolicies(policy.retentionPolicies);
  validatePolicyFields(policy.fields, classifications, references);
  validateOfficialSources(policy.officialSources);
  validateRedactionCanaries(policy.redactionCanaries);
  return policy;
}

function validateHistory(record, path) {
  if (!Number.isInteger(record.recordVersion) || record.recordVersion < 1) fail(`${path}.recordVersion`, "must be a positive integer");
  if (record.immutableHistory !== true) fail(`${path}.immutableHistory`, "history must be immutable");
  if (!(record.supersedes === null || typeof record.supersedes === "string")) fail(`${path}.supersedes`, "must be null or a stable prior reference");
}

function validateApplicability(items) {
  for (const [index, item] of items.entries()) {
    const path = `assurance.applicability[${index}]`; validateHistory(item, path);
    if (!APPLICABILITY.includes(item.status)) fail(`${path}.status`, "unsupported applicability status");
    for (const key of ["workflow", "jurisdiction", "rationale", "reviewerRole", "effectiveDate", "approvalState"]) string(item[key], `${path}.${key}`);
    if (item.status !== "UNDETERMINED" && item.approvalState !== "QUALIFIED_APPROVED") fail(path, "non-undetermined applicability requires qualified approval");
  }
}

function validateControls(controls, sources) {
  for (const [index, control] of controls.entries()) {
    const path = `assurance.controls[${index}]`; validateHistory(control, path);
    for (const key of ["ruleFamily", "designation", "safeguardType", "ownerRole", "policyRef", "implementationRationale", "nextReview", "implementationState", "evidenceState", "exceptionState", "approvalState"]) string(control[key], `${path}.${key}`);
    if (!control.sourceIds?.length || control.sourceIds.some((id) => !sources.has(id))) fail(`${path}.sourceIds`, "official source required");
    if (!control.evidenceExpectations?.length) fail(`${path}.evidenceExpectations`, "must not be empty");
    object(control.reviewCadence, `${path}.reviewCadence`);
    if (control.designation.startsWith("ADDRESSABLE") && !control.addressableAssessment) fail(`${path}.addressableAssessment`, "ADDRESSABLE requires assessment and rationale and is not OPTIONAL");
  }
}

function validateEvidence(evidenceItems, controls) {
  const evidenceStates = new Set();
  const controlIds = new Set(controls.map((control) => control.id));
  for (const [index, evidence] of evidenceItems.entries()) {
    const path = `assurance.evidence[${index}]`; validateHistory(evidence, path); evidenceStates.add(evidence.state);
    for (const key of ["controlId", "kind", "state", "provenance", "versionOrHash", "custodianRole", "result"]) string(evidence[key], `${path}.${key}`);
    if (!controlIds.has(evidence.controlId)) fail(`${path}.controlId`, "unknown control");
  }
  for (const state of EVIDENCE_STATES) if (!evidenceStates.has(state)) fail("assurance.evidence", `missing evidence lifecycle state ${state}`);
}

function validateRisks(risks) {
  for (const [index, risk] of risks.entries()) {
    const path = `assurance.risks[${index}]`; validateHistory(risk, path);
    for (const key of ["threat", "vulnerability", "likelihood", "impact", "inherentRisk", "residualRisk", "treatment", "ownerRole", "dueDate", "approvalState"]) string(risk[key], `${path}.${key}`);
    if (!risk.scope?.length || !risk.reassessmentTriggers?.length) fail(path, "scope and reassessment triggers are required");
  }
}

function validateVendors(vendors) {
  for (const [index, vendor] of vendors.entries()) {
    const path = `assurance.vendors[${index}]`; validateHistory(vendor, path);
    for (const key of ["legalEntity", "exactService", "hipaaRole", "purpose", "baaStatus", "contractStatus", "region", "retentionDeletion", "incidentObligations", "reviewDate"]) string(vendor[key], `${path}.${key}`);
    if (!vendor.dataClasses?.length) fail(`${path}.dataClasses`, "must list data handled");
    if (vendor.phiEligible === true && !(vendor.baaStatus.startsWith("EXECUTED") && vendor.approvedConfiguration && vendor.subprocessorEvidence && vendor.approvalEvidenceRef)) fail(path, "PHI eligibility requires exact-service BAA, configuration, subprocessor, and approval evidence");
  }
}

function validateEvaluations(evaluations) {
  for (const [index, evaluation] of evaluations.entries()) {
    const path = `assurance.evaluations[${index}]`; validateHistory(evaluation, path);
    for (const key of ["evaluator", "evaluatorIndependence", "residualRisk", "approvalState", "evaluatedAt", "nextReview"]) string(evaluation[key], `${path}.${key}`);
    if (!evaluation.scope?.length || !evaluation.methods?.length || !evaluation.materialChangeTriggers?.length) fail(path, "scope, methods, and material-change triggers are required");
  }
}

function validateCorrectiveActions(actions, path) {
  for (const action of actions) {
    for (const key of ["id", "ownerRole", "dueDate", "status"]) string(action[key], `${path}.correctiveActions.${key}`);
  }
}

function validateIncidents(incidents) {
  for (const incident of incidents) {
    validateHistory(incident, `assurance.incidents.${incident.id}`);
    if (incident.type === "POTENTIAL_BREACH" && incident.legalDetermination !== null) fail(`assurance.incidents.${incident.id}.legalDetermination`, "synthetic validator must not automate a legal breach determination");
    if (!incident.correctiveActions?.length || !incident.auditLineage?.length) fail(`assurance.incidents.${incident.id}`, "corrective actions and audit lineage required");
    validateCorrectiveActions(incident.correctiveActions, `assurance.incidents.${incident.id}`);
  }
}

function validateContingency(items) {
  for (const item of items) {
    validateHistory(item, `assurance.contingency.${item.id}`);
    if (!item.evidenceRefs?.length || !item.correctiveActions?.length) fail(`assurance.contingency.${item.id}`, "evidence and corrective actions required");
    validateCorrectiveActions(item.correctiveActions, `assurance.contingency.${item.id}`);
  }
}

function validateWorkforce(workforce) {
  object(workforce, "assurance.workforce");
  for (const key of ["responsibilityRoles", "training", "sanctions", "accessReviews", "breakGlassReviews", "policyVersions"]) {
    if (!workforce[key]?.length) fail(`assurance.workforce.${key}`, "must not be empty");
  }
}

function validateAssuranceTypes(assurances) {
  const assuranceTypes = assurances.map((item) => item.type).sort();
  if (canonicalJson(assuranceTypes) !== canonicalJson([...ASSURANCE_TYPES].sort())) fail("assurance.assurances", "must contain all four assurance types");
  for (const item of assurances) {
    if (!item.limitations?.some((x) => /NOT_HHS_CERTIFICATION|NOT_HIPAA_EQUIVALENCE/.test(x))) fail(`assurance.assurances.${item.id}`, "must deny certification/equivalence");
    if (!item.limitations.includes("NOT_BAA_SUBSTITUTE")) fail(`assurance.assurances.${item.id}`, "must deny BAA substitution");
  }
}

export function validateAssurance(assurance, policy) {
  object(assurance, "assurance");
  for (const key of ["applicability", "controls", "evidence", "risks", "vendors", "evaluations", "incidents", "contingency", "assurances"]) {
    array(assurance[key], `assurance.${key}`); unique(assurance[key], "id", `assurance.${key}`);
  }
  validateApplicability(assurance.applicability);
  validateControls(assurance.controls, new Set(policy.officialSources.map((item) => item.id)));
  validateEvidence(assurance.evidence, assurance.controls);
  validateRisks(assurance.risks);
  validateVendors(assurance.vendors);
  validateEvaluations(assurance.evaluations);
  validateIncidents(assurance.incidents);
  validateContingency(assurance.contingency);
  validateWorkforce(assurance.workforce);
  validateAssuranceTypes(assurance.assurances);
  return assurance;
}

function validateFlowContract(flow, policy) {
  object(flow, "flow");
  for (const key of ["id", "tenantId", "subject", "purpose", "role", "destination", "retentionClass", "policyVersion", "approvalState", "expectedDecision", "expectedReason"]) string(flow[key], `flow.${key}`);
  if (!policy.purposes.includes(flow.purpose)) fail("flow.purpose", "unknown purpose");
  if (!policy.roles.some((item) => item.id === flow.role)) fail("flow.role", "unknown role");
  if (!policy.destinations.some((item) => item.id === flow.destination)) fail("flow.destination", "unknown destination");
  if (!policy.retentionPolicies.some((x) => x.id === flow.retentionClass)) fail("flow.retentionClass", "missing retention basis");
  if (flow.policyVersion !== policy.policyVersion) fail("flow.policyVersion", "missing or stale policy version");
  if (!Array.isArray(flow.fieldIds) || !flow.fieldIds.length) fail("flow.fieldIds", "must not be empty");
  const fields = flow.fieldIds.map((id) => policy.fields.find((field) => field.id === id));
  if (fields.some((field) => !field)) fail("flow.fieldIds", "unknown field fails closed");
  return fields;
}

function tenantDecision(flow) {
  const referencedTenants = [flow.referencedTenantId, flow.relationship?.assignmentTenantId, flow.relationship?.relationshipTenantId];
  return referencedTenants.some((tenantId) => tenantId && tenantId !== flow.tenantId)
    ? { decision: "DENY", reason: "CROSS_TENANT_REFERENCE" }
    : null;
}

function workforceDecision(flow, assurance) {
  return assurance.workforce.accessReviews.some((item) => item.actor === flow.actor && item.accessState === "REVOKED")
    ? { decision: "DENY", reason: "WORKFORCE_ACCESS_REVOKED" }
    : null;
}

function claimDecision(flow) {
  return flow.claim && FORBIDDEN_CLAIMS.includes(flow.claim)
    ? { decision: "DENY", reason: "FORBIDDEN_COMPLIANCE_OR_CERTIFICATION_CLAIM" }
    : null;
}

function applicabilityDecision(flow, assurance) {
  if (flow.applicabilityId) {
    const item = assurance.applicability.find((candidate) => candidate.id === flow.applicabilityId);
    if (!item || item.status === "UNDETERMINED") return { decision: "BLOCKED", reason: "HIPAA_ROLE_UNDETERMINED" };
  }
  if (flow.applicabilityOverride) {
    const item = flow.applicabilityOverride;
    if (!APPLICABILITY.includes(item.status) || item.status === "UNDETERMINED" || item.approvalState !== "QUALIFIED_APPROVAL_EXAMPLE" || !item.approvalEvidenceRef) return { decision: "BLOCKED", reason: "QUALIFIED_APPLICABILITY_APPROVAL_MISSING" };
    return { decision: "ELIGIBLE_FOR_FURTHER_REVIEW", reason: "QUALIFIED_APPLICABILITY_REPRESENTED_NOT_PRODUCTION_APPROVAL" };
  }
  return null;
}

function riskDecision(flow, assurance) {
  return flow.riskIds?.some((id) => assurance.risks.some((risk) => risk.id === id && risk.residualRisk === "CRITICAL" && risk.approvalState === "UNACCEPTED"))
    ? { decision: "BLOCKED", reason: "CRITICAL_RISK_UNTREATED" }
    : null;
}

function evaluationDecision(flow, assurance) {
  if (flow.evaluationId) {
    const item = assurance.evaluations.find((candidate) => candidate.id === flow.evaluationId);
    if (!item || item.approvalState === "EXPIRED" || flow.materialChange) return { decision: "BLOCKED", reason: "EVALUATION_STALE_OR_MATERIAL_CHANGE" };
  }
  return null;
}

function incidentDecision(flow, assurance) {
  if (flow.incidentId) {
    const item = assurance.incidents.find((candidate) => candidate.id === flow.incidentId);
    if (!item || item.legalDetermination === null || item.correctiveActions.some((action) => action.status !== "CLOSED")) return { decision: "BLOCKED", reason: "QUALIFIED_BREACH_DETERMINATION_REQUIRED" };
  }
  return null;
}

function contingencyDecision(flow, assurance) {
  if (flow.contingencyId) {
    const item = assurance.contingency.find((candidate) => candidate.id === flow.contingencyId);
    if (!item || item.result !== "PASS" || item.deletionReconciliation !== "COMPLETE") return { decision: "BLOCKED", reason: "RESTORE_OR_DELETION_RECONCILIATION_INCOMPLETE" };
  }
  return null;
}

function deletionDecision(flow) {
  if (flow.deletion) {
    if (flow.deletion.legalHold) return { decision: "BLOCKED", reason: "LEGAL_HOLD_PRECEDENCE" };
    if (flow.deletion.completionReported && flow.deletion.destinations.some((destination) => destination.state !== "DELETED")) return { decision: "DENY", reason: "DELETION_DESTINATION_UNRESOLVED" };
  }
  return null;
}

function vendorDecision(flow, fields, assurance) {
  if (flow.vendorId) {
    const vendor = assurance.vendors.find((candidate) => candidate.id === flow.vendorId);
    if (!vendor) return { decision: "BLOCKED", reason: "EXACT_SERVICE_VENDOR_RECORD_MISSING" };
    if (fields.some((field) => field.classifications.includes("REGULATED_HEALTH")) && !vendor.phiEligible) {
      const reason = vendor.baaStatus === "MISSING" ? "EXACT_SERVICE_BAA_OR_APPROVAL_MISSING" : "SYNTHETIC_VENDOR_NOT_PRODUCTION_APPROVED";
      return { decision: "BLOCKED", reason };
    }
  }
  return null;
}

function roleDecision(flow, fields) {
  if (flow.role === "DRIVER" && flow.relationship?.assigned !== true) return { decision: "DENY", reason: "DRIVER_NOT_ASSIGNED" };
  if (flow.role === "FACILITY_USER" && fields.some((field) => field.classifications.includes("RESTRICTED_LOCATION"))) return { decision: "DENY", reason: "FACILITY_FLEET_LOCATION_PROHIBITED" };
  if (flow.role === "BILLING_USER" && fields.some((field) => field.id === "location.breadcrumb")) return { decision: "DENY", reason: "ADDITIONAL_LOCATION_PURPOSE_REQUIRED" };
  return null;
}

function specialPurposeDecision(flow, policy) {
  if (flow.purpose === "MAPS_ROUTE_GUIDANCE") {
    if (flow.fieldIds.some((id) => !policy.mapsAllowlist.includes(id)) || (flow.telemetryFieldIds ?? []).some((id) => !policy.observabilityAllowlist.includes(id))) return { decision: "DENY", reason: "MAPS_NON_ALLOWLISTED_FIELD" };
    return { decision: "ALLOW_SYNTHETIC_CONTRACT", reason: "MAPS_ROUTE_GUIDANCE_ALLOWLIST_ONLY" };
  }
  if (flow.purpose === "OBSERVABILITY") {
    if (flow.fieldIds.some((id) => !policy.observabilityAllowlist.includes(id)) || flow.canaryKinds?.length) return { decision: "DENY", reason: "OBSERVABILITY_SENSITIVE_FIELD_REJECTED" };
    return { decision: "ALLOW_SYNTHETIC_CONTRACT", reason: "OBSERVABILITY_ALLOWLIST_ONLY" };
  }
  if (flow.purpose === "BREAK_GLASS") {
    const bg = flow.breakGlass;
    if (!bg?.reason || !bg.actor || !bg.approvedBy || !bg.expiresAt || !bg.auditRef || !(new Date(flow.evaluationTime) < new Date(bg.expiresAt))) return { decision: "DENY", reason: "BREAK_GLASS_REQUIREMENTS_MISSING_OR_EXPIRED" };
    return { decision: "ALLOW_SYNTHETIC_CONTRACT", reason: "BREAK_GLASS_REQUIREMENTS_PRESENT" };
  }
  return null;
}

const FLOW_ALLOW_REASONS = Object.freeze({
  FLOW_DISPATCHER_RIDER_INTAKE: "APPROVED_INTERNAL_PURPOSE",
  FLOW_DRIVER_ASSIGNED_MANIFEST: "MINIMUM_ASSIGNED_MANIFEST",
  FLOW_FACILITY_RELATED_TRIP: "FACILITY_RELATIONSHIP_CONFIRMED",
  FLOW_BILLING_TRIP_PROOF: "BILLING_PROOF_MINIMUM",
  FLOW_SUPPORT_MASKED_DIAGNOSTICS: "MASKED_DIAGNOSTICS_ONLY",
  FLOW_PUSH_OPAQUE_WAKEUP: "OPAQUE_WAKEUP_ONLY"
});

function fieldPolicyDecision(flow, fields) {
  const permitted = fields.every((field) => field.purposes.includes(flow.purpose) && field.roles.includes(flow.role) && field.destinations.includes(flow.destination));
  if (!permitted) return { decision: "DENY", reason: "FIELD_POLICY_DENIED" };
  return { decision: "ALLOW_SYNTHETIC_CONTRACT", reason: FLOW_ALLOW_REASONS[flow.id] ?? "FIELD_POLICY_ALLOWLIST" };
}

export function evaluateFlow(flow, policy, assurance) {
  const fields = validateFlowContract(flow, policy);
  const orderedEvaluators = [
    () => tenantDecision(flow),
    () => workforceDecision(flow, assurance),
    () => claimDecision(flow),
    () => applicabilityDecision(flow, assurance),
    () => riskDecision(flow, assurance),
    () => evaluationDecision(flow, assurance),
    () => incidentDecision(flow, assurance),
    () => contingencyDecision(flow, assurance),
    () => deletionDecision(flow),
    () => vendorDecision(flow, fields, assurance),
    () => roleDecision(flow, fields),
    () => specialPurposeDecision(flow, policy)
  ];
  for (const evaluate of orderedEvaluators) {
    const decision = evaluate();
    if (decision) return decision;
  }
  return fieldPolicyDecision(flow, fields);
}

export function validateFlows(flowRegistry, policy, assurance) {
  object(flowRegistry, "flowRegistry"); array(flowRegistry.flows, "flowRegistry.flows"); unique(flowRegistry.flows, "id", "flowRegistry.flows");
  for (const flow of flowRegistry.flows) {
    const actual = evaluateFlow(flow, policy, assurance);
    if (actual.decision !== flow.expectedDecision || actual.reason !== flow.expectedReason) fail(`flowRegistry.${flow.id}`, `expected ${flow.expectedDecision}/${flow.expectedReason}, got ${actual.decision}/${actual.reason}`);
  }
  return flowRegistry;
}

export function productionReadiness(assurance) {
  const blockers = [];
  if (assurance.applicability.some((x) => x.status === "UNDETERMINED")) blockers.push("HIPAA_ROLE_UNDETERMINED");
  if (assurance.risks.some((x) => x.residualRisk === "CRITICAL" && x.approvalState !== "ACCEPTED_BY_AUTHORITY")) blockers.push("CRITICAL_RISK_UNTREATED");
  if (assurance.controls.some((x) => x.evidenceState === "EXPIRED" || x.exceptionState === "OPEN")) blockers.push("CONTROL_EVIDENCE_OR_REMEDIATION_OPEN");
  if (assurance.controls.some((x) => !["REVIEWED", "QUALIFIED_APPROVAL"].includes(x.evidenceState))) blockers.push("CONTROL_EVIDENCE_INCOMPLETE");
  if (assurance.vendors.some((x) => x.dataClasses.includes("REGULATED_HEALTH") && !x.phiEligible)) blockers.push("EXACT_SERVICE_BAA_OR_APPROVAL_MISSING");
  if (assurance.evaluations.some((x) => x.approvalState === "EXPIRED")) blockers.push("EVALUATION_STALE");
  if (assurance.incidents.some((x) => x.correctiveActions.some((a) => a.status !== "CLOSED"))) blockers.push("INCIDENT_ACTION_OPEN");
  if (assurance.contingency.some((x) => x.result !== "PASS" || x.deletionReconciliation !== "COMPLETE")) blockers.push("CONTINGENCY_OR_RESTORE_EVIDENCE_MISSING");
  if (assurance.risks.some((x) => !x.ownerRole) || assurance.incidents.some((x) => x.correctiveActions.some((a) => !a.ownerRole)) || assurance.contingency.some((x) => x.correctiveActions.some((a) => !a.ownerRole))) blockers.push("UNOWNED_REMEDIATION");
  return { status: "BLOCKED_NOT_PRODUCTION_PHI_READY", blockers: [...new Set(blockers)].sort(), legalComplianceDetermination: null };
}

export function normalizeBundle(classifications, policy, assurance, flows) {
  validatePolicy(policy, classifications); validateAssurance(assurance, policy); validateFlows(flows, policy, assurance);
  const flowDecisions = flows.flows.map((flow) => ({ id: flow.id, seed: `${flows.fixtureSeed}|${flow.id}`, ...evaluateFlow(flow, policy, assurance) }));
  const normalized = {
    contractType: "kavaroutes.synthetic-privacy-hipaa-assurance",
    schemaVersion: "1.0.0", synthetic: true, policyVersion: policy.policyVersion,
    classifications, policy, assurance, flows, flowDecisions, productionReadiness: productionReadiness(assurance),
    limitations: ["NO_LEGAL_ADVICE", "NO_HIPAA_CERTIFICATION", "NO_COMPLIANCE_CLAIM", "NO_PRODUCTION_PHI_APPROVAL", "NO_VENDOR_APPROVAL"]
  };
  return { ...normalized, digest: digest(normalized) };
}
