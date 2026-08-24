import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const GLOSSARY_IDS = ["SERVICE_DATE","TRIP_REQUEST","LEG","STOP_TASK","RUN","ASSIGNMENT","EXECUTION_SEGMENT","STANDING_ORDER","WILL_CALL","MULTI_LOAD","COMPANION_ESCORT","AUTHORIZATION","EVIDENCE","DEADHEAD","BILLING_CASE","INCIDENT"];
const AGGREGATE_IDS = ["RIDER","FACILITY_ADDRESS","TRIP_REQUEST","AUTHORIZATION","RUN","ASSIGNMENT","LEG_EXECUTION","EVIDENCE_RECORD","LOCATION_STREAM","BILLING_CASE","INVOICE_CLAIM","INTEGRATION_RECEIPT","AUDIT_EVENT"];
const MACHINE_IDS = ["TRIP_INTAKE","LEG_TIMING_WILL_CALL","LEG_EXECUTION","RUN_LIFECYCLE","ASSIGNMENT_LIFECYCLE","EVIDENCE_REVIEW","BILLING_CASE","INVOICE_LIFECYCLE","CLAIM_LIFECYCLE"];
const POLICY_TOPICS = ["WAIT_DURATION","LATE_TOLERANCE","NO_SHOW_COMPENSATION","DOCUMENTATION","MODE","SERVICE_AREA","AUTHORIZATION"];
const REQUIRED_HARD = ["TENANT_SCOPE","SERVICE_TIME_CONTEXT","SINGLE_ACTIVE_ASSIGNMENT","RESOURCE_INTERVAL_OVERLAP","EXECUTION_SEQUENCE","WILL_CALL_READY_CLOCK","MULTI_LOAD_CAPACITY","RESOURCE_SAFETY_QUALIFICATION","IDEMPOTENT_OPTIMISTIC_COMMAND","APPEND_ONLY_LINEAGE","NON_AUTHORITATIVE_INPUTS","FINANCIAL_ELIGIBILITY"];
const SCENARIO_TYPES = ["DUPLICATE_DELIVERY","CONCURRENT_DISPATCH","BROKER_LOCAL_CONFLICT","STANDING_ORDER_EDIT","OFFLINE_OUT_OF_ORDER","DUPLICATE_WILL_CALL","POST_BOARDING_CANCELLATION","UNSUPPORTED_NO_SHOW","ONBOARD_BREAKDOWN_TRANSFER","MULTI_LOAD_CONFLICT","MID_RUN_DISQUALIFICATION","PARTIAL_ROUND_TRIP","DST_OVERNIGHT","VENDOR_OUTAGE","POST_ISSUE_CORRECTION","TENANT_MISMATCH"];

function fail(path, message) { throw new Error(`${path}: ${message}`); }
function object(value, path) { if (!value || typeof value !== "object" || Array.isArray(value)) fail(path, "must be an object"); }
function array(value, path) { if (!Array.isArray(value)) fail(path, "must be an array"); }
function string(value, path) { if (typeof value !== "string" || !value.trim()) fail(path, "must be a non-empty string"); }
function exactIds(actual, expected, path) {
  if (canonicalJson([...actual].sort()) !== canonicalJson([...expected].sort())) fail(path, `must contain exactly ${expected.join(", ")}`);
}
function unique(items, key, path) {
  const seen = new Set();
  for (const [index, item] of items.entries()) {
    const id = item[key]; string(id, `${path}[${index}].${key}`);
    if (seen.has(id)) fail(`${path}[${index}].${key}`, `duplicate ${id}`);
    seen.add(id);
  }
}

export function canonicalJson(value) {
  const sort = (item) => Array.isArray(item) ? item.map(sort) : item && typeof item === "object"
    ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, sort(item[key])])) : item;
  return `${JSON.stringify(sort(value), null, 2)}\n`;
}

export function digest(value) { return createHash("sha256").update(canonicalJson(value)).digest("hex"); }
export async function readJson(path) { return JSON.parse(await readFile(path, "utf8")); }

export function validateGlossary(glossary) {
  object(glossary, "glossary");
  if (glossary.schemaVersion !== "1.0.0") fail("glossary.schemaVersion", "must be 1.0.0");
  if (glossary.status !== "PROVISIONAL_PENDING_OPERATOR_VALIDATION") fail("glossary.status", "must remain provisional");
  array(glossary.terms, "glossary.terms"); unique(glossary.terms, "id", "glossary.terms");
  exactIds(glossary.terms.map((x) => x.id), GLOSSARY_IDS, "glossary.terms");
  for (const [index, term] of glossary.terms.entries()) for (const key of ["label","definition","distinction"]) string(term[key], `glossary.terms[${index}].${key}`);
  return glossary;
}

export function validateAggregates(registry) {
  object(registry, "aggregates"); array(registry.aggregates, "aggregates.aggregates"); unique(registry.aggregates, "id", "aggregates.aggregates");
  exactIds(registry.aggregates.map((x) => x.id), AGGREGATE_IDS, "aggregates.aggregates");
  const ids = new Set(AGGREGATE_IDS), owners = new Set(), mutableRules = new Map();
  for (const [index, aggregate] of registry.aggregates.entries()) {
    const path = `aggregates.aggregates[${index}]`;
    string(aggregate.provenance, `${path}.provenance`); string(aggregate.owner, `${path}.owner`); if (owners.has(aggregate.owner)) fail(`${path}.owner`, "one owner may not silently own multiple aggregates"); owners.add(aggregate.owner);
    if (aggregate.tenantScope !== "TENANT_REQUIRED") fail(`${path}.tenantScope`, "tenant scope must fail closed");
    for (const key of ["owns","allowedReferences","mustNotOwn"]) array(aggregate[key], `${path}.${key}`);
    if (!aggregate.owns.length || !aggregate.mustNotOwn.length) fail(path, "ownership and prohibited ownership must be explicit");
    for (const ref of aggregate.allowedReferences) if (!ids.has(ref)) fail(`${path}.allowedReferences`, `unknown aggregate ${ref}`);
    for (const rule of aggregate.owns) {
      if (mutableRules.has(rule)) fail(`${path}.owns`, `${rule} already owned by ${mutableRules.get(rule)}`);
      if (aggregate.mustNotOwn.includes(rule)) fail(path, `${rule} cannot be both owned and prohibited`);
      mutableRules.set(rule, aggregate.id);
    }
  }
  return registry;
}

export function validateCatalog(catalog, aggregates) {
  object(catalog, "catalog"); array(catalog.commands, "catalog.commands"); unique(catalog.commands, "id", "catalog.commands");
  const aggregateIds = new Set(aggregates.aggregates.map((x) => x.id));
  for (const [index, command] of catalog.commands.entries()) {
    const path = `catalog.commands[${index}]`; string(command.area, `${path}.area`);
    if (!aggregateIds.has(command.aggregate)) fail(`${path}.aggregate`, "unknown aggregate");
    if (command.event !== null) string(command.event, `${path}.event`);
  }
  for (const forbidden of ["SetStatus","PatchStatus","UpdateStatus"]) if (!catalog.forbiddenGenericCommands.includes(forbidden)) fail("catalog.forbiddenGenericCommands", `missing ${forbidden}`);
  const requiredCommandFields = ["commandId","tenantId","aggregateType","aggregateId","expectedAggregateVersion","idempotencyKey","actorType","actorId","occurredAt","source","correlationId","causationId","schemaVersion","classificationIds","policyVersion"];
  const requiredEventFields = ["eventId","tenantId","aggregateType","aggregateId","aggregateVersion","eventType","schemaVersion","occurredAt","recordedAt","actorType","actorId","commandId","idempotencyKey","correlationId","causationId","source","classificationIds","policyVersion"];
  exactIds(catalog.commandEnvelope.required, requiredCommandFields, "catalog.commandEnvelope.required");
  exactIds(catalog.eventEnvelope.required, requiredEventFields, "catalog.eventEnvelope.required");
  if (catalog.eventEnvelope.outboxAtomicWithDomainMutation !== true || catalog.eventEnvelope.consumerTenantScopeRequired !== true) fail("catalog.eventEnvelope", "atomic outbox and tenant-scoped consumption are required");
  return catalog;
}

export function validateMachines(registry, aggregates, catalog) {
  object(registry, "machines"); array(registry.machines, "machines.machines"); unique(registry.machines, "id", "machines.machines");
  exactIds(registry.machines.map((x) => x.id), MACHINE_IDS, "machines.machines");
  const aggregateIds = new Set(aggregates.aggregates.map((x) => x.id));
  const commandMap = new Map(catalog.commands.map((x) => [x.id, x]));
  for (const [machineIndex, machine] of registry.machines.entries()) {
    const path = `machines.machines[${machineIndex}]`; string(machine.defaultRejection, `${path}.defaultRejection`);
    if (!aggregateIds.has(machine.ownerAggregate)) fail(`${path}.ownerAggregate`, "unknown aggregate");
    array(machine.states, `${path}.states`); array(machine.transitions, `${path}.transitions`); array(machine.explicitProhibitions, `${path}.explicitProhibitions`);
    unique(machine.states, "id", `${path}.states`); unique(machine.transitions, "id", `${path}.transitions`); unique(machine.explicitProhibitions, "id", `${path}.explicitProhibitions`);
    const states = new Set(machine.states.map((x) => x.id));
    for (const state of machine.states) if (typeof state.terminal !== "boolean") fail(`${path}.states.${state.id}.terminal`, "must be boolean");
    for (const transition of machine.transitions) {
      for (const key of ["from","to","command","guard","event"]) string(transition[key], `${path}.transitions.${transition.id}.${key}`);
      if (!states.has(transition.from) || !states.has(transition.to)) fail(`${path}.transitions.${transition.id}`, "unknown state");
      const command = commandMap.get(transition.command); if (!command) fail(`${path}.transitions.${transition.id}.command`, "unknown command");
      if (command.event !== transition.event) fail(`${path}.transitions.${transition.id}.event`, `must match catalog event ${command.event}`);
    }
    for (const prohibition of machine.explicitProhibitions) {
      for (const key of ["from","command","reason"]) string(prohibition[key], `${path}.explicitProhibitions.${prohibition.id}.${key}`);
      if (!states.has(prohibition.from) || !commandMap.has(prohibition.command)) fail(`${path}.explicitProhibitions.${prohibition.id}`, "unknown state or command");
    }
  }
  return registry;
}

export function validateConstraints(registry) {
  object(registry, "constraints"); array(registry.constraints, "constraints.constraints"); unique(registry.constraints, "id", "constraints.constraints");
  const allowedKinds = new Set(["ALWAYS_HARD","POLICY_HARD","SOFT"]);
  for (const [index, constraint] of registry.constraints.entries()) {
    const path = `constraints.constraints[${index}]`;
    for (const key of ["scope","source","effectivePolicy","evaluation","override"]) string(constraint[key], `${path}.${key}`);
    if (!allowedKinds.has(constraint.kind)) fail(`${path}.kind`, "unknown constraint kind");
    if (constraint.kind === "ALWAYS_HARD" && constraint.override !== "NEVER") fail(`${path}.override`, "always-hard invariants cannot be overridden");
  }
  const byId = new Map(registry.constraints.map((x) => [x.id, x]));
  for (const id of REQUIRED_HARD) if (byId.get(id)?.kind !== "ALWAYS_HARD" || byId.get(id)?.override !== "NEVER") fail("constraints.constraints", `${id} must be non-overridable ALWAYS_HARD`);
  return registry;
}

export function validatePolicies(registry) {
  object(registry, "policies"); array(registry.fixtures, "policies.fixtures"); unique(registry.fixtures, "id", "policies.fixtures");
  if (registry.status !== "PROVISIONAL_PENDING_OPERATOR_AND_QUALIFIED_REVIEW" || registry.customerSpecificBranches !== false) fail("policies", "must remain provisional and customer-name independent");
  const topics = new Set(registry.fixtures.map((x) => x.topic));
  for (const topic of POLICY_TOPICS) if (!topics.has(topic)) fail("policies.fixtures", `missing provisional ${topic} fixture`);
  for (const [index, fixture] of registry.fixtures.entries()) {
    const path = `policies.fixtures[${index}]`;
    for (const key of ["topic","scope","effectiveFrom","approval","provenance"]) string(fixture[key], `${path}.${key}`);
    object(fixture.value, `${path}.value`);
    if (fixture.approval !== "NOT_PRODUCTION_APPROVED") fail(`${path}.approval`, "policy fixtures must not claim production approval");
    if (/customerName|tenantName/i.test(JSON.stringify(fixture))) fail(path, "customer-name conditional logic is forbidden");
  }
  return registry;
}

export function executeTransition(input, machines) {
  const machine = machines.machines.find((x) => x.id === input.machineId);
  if (!machine) return { decision:"REJECT", reason:"UNKNOWN_MACHINE", state:input.state, version:input.currentVersion, emittedEvents:[] };
  if (!input.tenantId || input.referencedTenantIds?.some((id) => id !== input.tenantId)) return { decision:"REJECT", reason:"TENANT_MISMATCH", state:input.state, version:input.currentVersion, emittedEvents:[] };
  if (!input.idempotencyKey) return { decision:"REJECT", reason:"IDEMPOTENCY_KEY_REQUIRED", state:input.state, version:input.currentVersion, emittedEvents:[] };
  if (input.processedKeys?.includes(`${input.tenantId}|${input.idempotencyKey}`)) return { decision:"NO_EFFECT", reason:"DUPLICATE_NO_EFFECT", state:input.state, version:input.currentVersion, emittedEvents:[] };
  if (input.expectedVersion !== input.currentVersion) return { decision:"REJECT", reason:"VERSION_CONFLICT", state:input.state, version:input.currentVersion, emittedEvents:[] };
  const prohibited = machine.explicitProhibitions.find((x) => x.from === input.state && x.command === input.command);
  if (prohibited) return { decision: prohibited.reason === "DUPLICATE_NO_EFFECT" ? "NO_EFFECT" : "REJECT", reason:prohibited.reason, state:input.state, version:input.currentVersion, emittedEvents:[] };
  const transition = machine.transitions.find((x) => x.from === input.state && x.command === input.command);
  if (!transition) return { decision:"REJECT", reason:machine.defaultRejection, state:input.state, version:input.currentVersion, emittedEvents:[] };
  if (input.guardResults?.[transition.guard] === false) return { decision:"REJECT", reason:`GUARD_FAILED_${transition.guard.toUpperCase()}`, state:input.state, version:input.currentVersion, emittedEvents:[] };
  return { decision:"ACCEPT", reason:"TRANSITION_APPLIED", state:transition.to, version:input.currentVersion + 1, emittedEvents:[transition.event] };
}

export function validateCommandEnvelope(envelope, catalog) {
  object(envelope, "commandEnvelope");
  for (const key of catalog.commandEnvelope.required) {
    if (key === "expectedAggregateVersion") { if (!Number.isInteger(envelope[key]) || envelope[key] < 0) fail(`commandEnvelope.${key}`, "must be a non-negative integer"); }
    else if (key === "classificationIds") { if (!Array.isArray(envelope[key]) || !envelope[key].length) fail(`commandEnvelope.${key}`, "must be a non-empty array"); }
    else string(envelope[key], `commandEnvelope.${key}`);
  }
  if (catalog.forbiddenGenericCommands.includes(envelope.commandType)) fail("commandEnvelope.commandType", "generic status mutation is forbidden");
  return envelope;
}

export function validateEventEnvelope(envelope, catalog) {
  object(envelope, "eventEnvelope");
  for (const key of catalog.eventEnvelope.required) {
    if (key === "aggregateVersion") { if (!Number.isInteger(envelope[key]) || envelope[key] < 1) fail(`eventEnvelope.${key}`, "must be a positive integer"); }
    else if (key === "classificationIds") { if (!Array.isArray(envelope[key]) || !envelope[key].length) fail(`eventEnvelope.${key}`, "must be a non-empty array"); }
    else string(envelope[key], `eventEnvelope.${key}`);
  }
  if (envelope.referencedTenantId && envelope.referencedTenantId !== envelope.tenantId) fail("eventEnvelope.referencedTenantId", "tenant mismatch");
  return envelope;
}

export function validateActiveAssignments(assignments) {
  for (let left = 0; left < assignments.length; left += 1) for (let right = left + 1; right < assignments.length; right += 1) {
    const a = assignments[left], b = assignments[right];
    const overlap = a.start < b.end && b.start < a.end;
    if (a.tenantId !== b.tenantId && (a.segmentId === b.segmentId || a.resourceId === b.resourceId)) fail("assignments", "cross-tenant resource or segment reference");
    if (overlap && a.active && b.active && a.segmentId === b.segmentId) fail("assignments", "multiple active assignments for one segment");
    if (overlap && a.active && b.active && a.resourceId === b.resourceId && !(a.nonDriving === true && b.nonDriving === true)) fail("assignments", "resource interval overlap");
  }
  return assignments;
}

export function validateMultiLoad({ capacity, occupants }) {
  const dimensions = Object.keys(capacity);
  for (const dimension of dimensions) {
    const used = occupants.reduce((sum, occupant) => sum + (occupant.load[dimension] ?? 0), 0);
    if (used > capacity[dimension]) return { decision:"REJECT", reason:"INTERVAL_CAPACITY_EXCEEDED", dimension, used, capacity:capacity[dimension] };
  }
  return { decision:"ACCEPT", reason:"INTERVAL_CAPACITY_AVAILABLE" };
}

export function evaluateBillingReadiness(input) {
  if (!input.eligibleOutcome) return { decision:"HOLD", reason:"ELIGIBLE_OUTCOME_REQUIRED" };
  if (!input.authorizationRef) return { decision:"HOLD", reason:"AUTHORIZATION_CONTEXT_REQUIRED" };
  if (!input.rateRef || !input.policyVersion) return { decision:"HOLD", reason:"RATE_AND_POLICY_PROVENANCE_REQUIRED" };
  if (!input.requiredEvidencePassed) return { decision:"HOLD", reason:"REQUIRED_EVIDENCE_FAILED" };
  if (["RIDER_NO_SHOW","CANCELLED"].includes(input.outcome) && !input.compensationPolicy?.explicitlyEligible) return { decision:"HOLD", reason:"EFFECTIVE_COMPENSATION_POLICY_REQUIRED" };
  return { decision:"READY", reason:"BILLING_READINESS_CONTRACT_PASSED" };
}

export function amendEvidence(original, amendment) {
  if (amendment.overwrite === true || amendment.originalId !== original.id) fail("evidenceAmendment", "append-only amendment with original lineage required");
  return { ...amendment, id:`${original.id}:amendment:${original.amendmentCount + 1}`, amendmentCount:original.amendmentCount + 1, originalPreserved:true };
}

export function correctIssuedFinancialFact(original, correction) {
  if (original.state === "ISSUED" && correction.kind === "OVERWRITE") fail("financialCorrection", "issued financial facts require adjustment or void lineage");
  if (!["ADJUSTMENT","VOID"].includes(correction.kind)) fail("financialCorrection.kind", "must be ADJUSTMENT or VOID");
  return { originalId:original.id, originalState:original.state, correctionKind:correction.kind, originalPreserved:true };
}

export function deriveAuthority(input) {
  if (["GPS","GEOFENCE","OPTIMIZER","REALTIME","PUSH"].includes(input.source)) return { decision:"EVIDENCE_OR_PROPOSAL_ONLY", authoritativeStateChanged:false };
  return { decision:"COMMAND_REQUIRED", authoritativeStateChanged:false };
}

const GOLDEN_RULES = {
  DUPLICATE_DELIVERY:{reasons:["IMPORT_FIRST_DELIVERY_APPLIED","DUPLICATE_NO_EFFECT","CALLBACK_FIRST_DELIVERY_APPLIED","DUPLICATE_NO_EFFECT","COMMAND_FIRST_DELIVERY_APPLIED","DUPLICATE_NO_EFFECT","LOCATION_BATCH_FIRST_DELIVERY_APPLIED","DUPLICATE_NO_EFFECT","OFFLINE_REPLAY_FIRST_DELIVERY_APPLIED","DUPLICATE_NO_EFFECT"],events:["TripDraftCreated","LegAmended","AssignmentAcknowledged","LocationBatchRecorded","DriverMarkedEnRoute"],attention:"NONE",financial:"NONE"},
  CONCURRENT_DISPATCH:{reasons:["VERSION_MATCH","VERSION_CONFLICT"],events:["AssignmentSuperseded"],attention:"SECOND_DISPATCHER_REFRESH_REQUIRED",financial:"NONE"},
  BROKER_LOCAL_CONFLICT:{reasons:["STALE_EXTERNAL_VERSION_AND_AUTHORITY_CONFLICT"],events:[],attention:"BROKER_LOCAL_AUTHORITY_REVIEW_REQUIRED",financial:"BILLING_HOLD"},
  STANDING_ORDER_EDIT:{reasons:["FUTURE_TEMPLATE_VERSION_CREATED","ONLY_NEW_INSTANCES_USE_NEW_VERSION"],events:["LegAmended","TripsMaterialized"],attention:"EXISTING_DISPATCHED_TRIPS_REQUIRE_SEPARATE_IMPACT_REVIEW",financial:"EXISTING_CASES_UNCHANGED"},
  OFFLINE_OUT_OF_ORDER:{reasons:["SEQUENCE_GAP","NEXT_SEQUENCE_APPLIED","BUFFERED_SEQUENCE_APPLIED","DUPLICATE_NO_EFFECT"],events:["DriverMarkedEnRoute","PickupArrivalRecorded"],attention:"NONE",financial:"NONE"},
  DUPLICATE_WILL_CALL:{reasons:["READY_AT_RECORDED","DUPLICATE_NO_EFFECT","CANCELLATION_AUTHORIZED","WILL_CALL_TERMINAL"],events:["WillCallMarkedReady","WillCallCancelled"],attention:"NONE",financial:"REQUIRES_CANCELLATION_POLICY_EVALUATION"},
  POST_BOARDING_CANCELLATION:{reasons:["ONBOARD_REQUIRES_INTERRUPTION_RECOVERY","INCIDENT_AND_RECOVERY_OPENED"],events:["LegInterrupted"],attention:"RECOVERY_DISPOSITION_REQUIRED",financial:"BILLING_HOLD_PENDING_OUTCOME"},
  UNSUPPORTED_NO_SHOW:{reasons:["NO_SHOW_EVIDENCE_POLICY_FAILED"],events:[],attention:"DISPATCHER_OR_BROKER_REVIEW_REQUIRED",financial:"NO_CHARGE_AND_BILLING_HOLD"},
  ONBOARD_BREAKDOWN_TRANSFER:{reasons:["INCIDENT_RECORDED","EXECUTION_INTERRUPTED","ASSIGNMENT_SUPERSEDED_WITH_NEW_SEGMENT","CUSTODY_TRANSFER_RECORDED","SEGMENTED_EXECUTION_COMPLETED"],events:["IncidentReported","LegInterrupted","AssignmentSuperseded","LegTransferred","LegCompleted"],attention:"INCIDENT_REVIEW_REQUIRED",financial:"READINESS_REEVALUATION_REQUIRED"},
  MULTI_LOAD_CONFLICT:{reasons:["INTERVAL_CAPACITY_OR_RIDE_TIME_CONFLICT"],events:[],attention:"ALTERNATE_RESOURCE_REQUIRED",financial:"NONE"},
  MID_RUN_DISQUALIFICATION:{reasons:["RESOURCE_SAFETY_QUALIFICATION_FAILED","QUALIFIED_REPLACEMENT_REQUIRED"],events:[],attention:"DISPATCH_REPLACEMENT_REQUIRED",financial:"NONE"},
  PARTIAL_ROUND_TRIP:{reasons:["OUTBOUND_NO_SHOW_RECORDED","RETURN_WILL_CALL_EXPIRED","LINKED_LEG_DISPOSITION_REVIEW_REQUIRED"],events:["RiderNoShowRecorded","WillCallExpired"],attention:"RETURN_DISPOSITION_AND_POLICY_REVIEW_REQUIRED",financial:"SEPARATE_LEG_POLICY_EVALUATIONS_AND_TRIP_HOLD"},
  DST_OVERNIGHT:{reasons:["EXPLICIT_SERVICE_TIME_CONTEXT","UTC_SEQUENCE_VALID","SERVICE_DATE_PRESERVED"],events:["RunPublished","RunStarted","RunCompleted"],attention:"NONE",financial:"SERVICE_DATE_REMAINS_OPERATOR_LOCAL"},
  VENDOR_OUTAGE:{reasons:["AUTHORITATIVE_COMMAND_CONTINUES_WITHOUT_VENDOR","AUTHORITATIVE_COMMAND_CONTINUES_WITHOUT_VENDOR"],events:["PickupArrivalRecorded","RiderBoarded"],attention:"DEGRADED_DELIVERY_AND_ROUTE_GUIDANCE_ALERT",financial:"NONE_UNLESS_EVIDENCE_POLICY_LATER_FAILS"},
  POST_ISSUE_CORRECTION:{reasons:["APPEND_ONLY_EVIDENCE_AMENDMENT","ADJUSTMENT_OR_VOID_REQUIRED","LINKED_FINANCIAL_ADJUSTMENT_CREATED"],events:["EvidenceAmended","InvoiceAdjusted"],attention:"BILLING_REVIEW_REQUIRED",financial:"ORIGINAL_ISSUE_PRESERVED_WITH_ADJUSTMENT"},
  TENANT_MISMATCH:{reasons:["TENANT_MISMATCH"],events:[],attention:"SECURITY_REVIEW_AND_AUDIT_REQUIRED",financial:"NONE"}
};

export function validateGoldenScenarios(registry) {
  object(registry, "scenarios"); array(registry.scenarios, "scenarios.scenarios"); unique(registry.scenarios, "id", "scenarios.scenarios");
  if (!registry.fixtureSeed.startsWith("kavaroutes-wp003-synthetic")) fail("scenarios.fixtureSeed", "must be conspicuously synthetic and stable");
  exactIds(registry.scenarios.map((x) => x.caseType), SCENARIO_TYPES, "scenarios.caseTypes");
  for (const [index, scenario] of registry.scenarios.entries()) {
    const path = `scenarios.scenarios[${index}]`; const rule = GOLDEN_RULES[scenario.caseType];
    object(scenario.initialState, `${path}.initialState`); object(scenario.inputs, `${path}.inputs`); object(scenario.finalState, `${path}.finalState`);
    for (const key of ["commandSequence","acceptedRejectedResults","emittedEvents"]) if (!Array.isArray(scenario[key])) fail(`${path}.${key}`, "must be an array");
    for (const key of ["humanAttention","retryBehavior","financialConsequence"]) string(scenario[key], `${path}.${key}`);
    const reasons = scenario.acceptedRejectedResults.map((x) => x.reason);
    if (canonicalJson(reasons) !== canonicalJson(rule.reasons)) fail(`${path}.acceptedRejectedResults`, "does not match independent golden rule");
    if (canonicalJson(scenario.emittedEvents) !== canonicalJson(rule.events)) fail(`${path}.emittedEvents`, "does not match independent golden rule");
    if (scenario.humanAttention !== rule.attention || scenario.financialConsequence !== rule.financial) fail(path, "attention or financial consequence does not match golden rule");
    if (/sk-[A-Za-z0-9]{12,}|AIza[A-Za-z0-9_-]{20,}/.test(JSON.stringify(scenario))) fail(path, "secret-shaped fixture forbidden");
    if (!scenario.commandSequence.length || !scenario.acceptedRejectedResults.length) fail(path, "command sequence and results required");
  }
  return registry;
}

export function validateBundle(bundle) {
  validateGlossary(bundle.glossary);
  validateAggregates(bundle.aggregates);
  validateCatalog(bundle.catalog, bundle.aggregates);
  validateMachines(bundle.machines, bundle.aggregates, bundle.catalog);
  validateConstraints(bundle.constraints);
  validatePolicies(bundle.policies);
  validateGoldenScenarios(bundle.scenarios);
  return bundle;
}

export function normalizeBundle(bundle) {
  validateBundle(bundle);
  const normalized = {
    contractType:"kavaroutes.synthetic-nemt-domain",
    schemaVersion:"1.0.0",
    synthetic:true,
    operationalStatus:"PROVISIONAL_PENDING_REAL_NEMT_OPERATOR_VALIDATION",
    ...bundle,
    limitations:["NO_PRODUCTION_SCHEMA_APPROVAL","NO_UNIVERSAL_NEMT_CLAIM","NO_PAYER_RULE_APPROVAL","NO_LEGAL_OR_COMPLIANCE_ADVICE","NO_PRODUCTION_SCAFFOLD"]
  };
  return { ...normalized, digest:digest(normalized) };
}
