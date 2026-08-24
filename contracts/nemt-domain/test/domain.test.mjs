import test from "node:test";
import assert from "node:assert/strict";
import {
  amendEvidence,
  canonicalJson,
  correctIssuedFinancialFact,
  deriveAuthority,
  evaluateBillingReadiness,
  executeTransition,
  normalizeBundle,
  validateActiveAssignments,
  validateAggregates,
  validateCommandEnvelope,
  validateConstraints,
  validateEventEnvelope,
  validateGoldenScenarios,
  validateMachines,
  validateMultiLoad,
  validatePolicies
} from "../lib/contracts.mjs";
import { loadBundle } from "../scripts/load.mjs";

const bundle = await loadBundle();
const transitionInput = (overrides = {}) => ({
  machineId:"LEG_EXECUTION", state:"ARRIVED_PICKUP", command:"BoardRider",
  tenantId:"syn_tenant_alpha", referencedTenantIds:["syn_tenant_alpha"],
  idempotencyKey:"syn_key_board_1", processedKeys:[], currentVersion:4, expectedVersion:4,
  ...overrides
});

test("same schema, seed, and inputs produce byte-equivalent normalized output", () => {
  assert.equal(canonicalJson(normalizeBundle(bundle)), canonicalJson(normalizeBundle(structuredClone(bundle))));
});

test("canonical registry includes all required glossary terms and aggregate owners", () => {
  assert.equal(bundle.glossary.terms.length, 16);
  assert.equal(bundle.aggregates.aggregates.length, 13);
  assert.equal(new Set(bundle.aggregates.aggregates.map((x) => x.owner)).size, 13);
});

test("aggregate ownership overlap and unknown references fail closed", () => {
  const overlap = structuredClone(bundle.aggregates); overlap.aggregates[1].owns.push(overlap.aggregates[0].owns[0]);
  assert.throws(() => validateAggregates(overlap), /already owned/);
  const unknown = structuredClone(bundle.aggregates); unknown.aggregates[0].allowedReferences.push("UNKNOWN_AGGREGATE");
  assert.throws(() => validateAggregates(unknown), /unknown aggregate/);
});

test("nine independent state machines exist and generic status mutation is forbidden", () => {
  assert.equal(bundle.machines.machines.length, 9);
  assert.ok(bundle.catalog.forbiddenGenericCommands.includes("SetStatus"));
  assert.equal(bundle.catalog.commands.some((x) => x.id === "SetStatus"), false);
});

test("every state and transition has stable ownership and rejection metadata", () => {
  for (const machine of bundle.machines.machines) {
    assert.ok(machine.ownerAggregate);
    assert.ok(machine.defaultRejection);
    for (const state of machine.states) assert.equal(typeof state.terminal, "boolean");
    for (const transition of machine.transitions) for (const key of ["id","from","to","command","guard","event"]) assert.ok(transition[key]);
    for (const prohibition of machine.explicitProhibitions) assert.ok(prohibition.reason);
  }
});

test("a legal execution transition advances one version and emits one event", () => {
  assert.deepEqual(executeTransition(transitionInput(), bundle.machines), { decision:"ACCEPT", reason:"TRANSITION_APPLIED", state:"ONBOARD", version:5, emittedEvents:["RiderBoarded"] });
});

test("rejected transitions leave authoritative state and version unchanged", () => {
  const result = executeTransition(transitionInput({ state:"ONBOARD", command:"CancelLeg" }), bundle.machines);
  assert.deepEqual(result, { decision:"REJECT", reason:"ONBOARD_REQUIRES_INTERRUPTION_RECOVERY", state:"ONBOARD", version:4, emittedEvents:[] });
});

test("undeclared transitions return a stable machine reason", () => {
  const result = executeTransition(transitionInput({ state:"PLANNED", command:"CompleteLeg" }), bundle.machines);
  assert.equal(result.reason, "LEG_EXECUTION_TRANSITION_NOT_DECLARED");
  assert.equal(result.state, "PLANNED");
});

test("duplicate commands have exactly one business effect", () => {
  const result = executeTransition(transitionInput({ processedKeys:["syn_tenant_alpha|syn_key_board_1"] }), bundle.machines);
  assert.deepEqual(result, { decision:"NO_EFFECT", reason:"DUPLICATE_NO_EFFECT", state:"ARRIVED_PICKUP", version:4, emittedEvents:[] });
});

test("stale aggregate versions conflict without last-write-wins", () => {
  const result = executeTransition(transitionInput({ expectedVersion:3 }), bundle.machines);
  assert.equal(result.reason, "VERSION_CONFLICT");
  assert.equal(result.version, 4);
});

test("cross-tenant commands and references fail closed", () => {
  const result = executeTransition(transitionInput({ referencedTenantIds:["syn_tenant_beta"] }), bundle.machines);
  assert.equal(result.reason, "TENANT_MISMATCH");
  assert.equal(result.state, "ARRIVED_PICKUP");
});

test("missing idempotency keys fail closed", () => {
  assert.equal(executeTransition(transitionInput({ idempotencyKey:"" }), bundle.machines).reason, "IDEMPOTENCY_KEY_REQUIRED");
});

test("guards reject without changing state", () => {
  const result = executeTransition(transitionInput({ guardResults:{ boarding_requirements_pass:false } }), bundle.machines);
  assert.equal(result.reason, "GUARD_FAILED_BOARDING_REQUIREMENTS_PASS");
  assert.equal(result.state, "ARRIVED_PICKUP");
});

test("one execution segment cannot have multiple active assignments", () => {
  assert.throws(() => validateActiveAssignments([
    {tenantId:"syn_tenant_alpha",segmentId:"syn_segment_1",resourceId:"syn_vehicle_1",start:0,end:10,active:true},
    {tenantId:"syn_tenant_alpha",segmentId:"syn_segment_1",resourceId:"syn_vehicle_2",start:5,end:12,active:true}
  ]), /multiple active assignments/);
});

test("driver and vehicle overlap is evaluated by effective interval", () => {
  assert.throws(() => validateActiveAssignments([
    {tenantId:"syn_tenant_alpha",segmentId:"syn_segment_1",resourceId:"syn_vehicle_1",start:0,end:10,active:true},
    {tenantId:"syn_tenant_alpha",segmentId:"syn_segment_2",resourceId:"syn_vehicle_1",start:9,end:12,active:true}
  ]), /resource interval overlap/);
  assert.doesNotThrow(() => validateActiveAssignments([
    {tenantId:"syn_tenant_alpha",segmentId:"syn_segment_1",resourceId:"syn_vehicle_1",start:0,end:10,active:true},
    {tenantId:"syn_tenant_alpha",segmentId:"syn_segment_2",resourceId:"syn_vehicle_1",start:10,end:12,active:true}
  ]));
});

test("multi-load capacity includes companions and equipment dimensions", () => {
  assert.equal(validateMultiLoad({capacity:{seated:2,wheelchair:1},occupants:[{load:{seated:1,wheelchair:1}},{load:{seated:2,wheelchair:0}}]}).reason, "INTERVAL_CAPACITY_EXCEEDED");
  assert.equal(validateMultiLoad({capacity:{seated:3,wheelchair:1},occupants:[{load:{seated:1,wheelchair:1}},{load:{seated:2,wheelchair:0}}]}).decision, "ACCEPT");
});

test("will-call clock cannot start before durable readiness", () => {
  const result = executeTransition(transitionInput({machineId:"LEG_TIMING_WILL_CALL",state:"WAITING_FOR_READY",command:"StartResponseClock"}), bundle.machines);
  assert.equal(result.reason, "READY_AT_REQUIRED");
});

test("GPS, geofence, optimizer, realtime, and push are never domain authority", () => {
  for (const source of ["GPS","GEOFENCE","OPTIMIZER","REALTIME","PUSH"]) assert.deepEqual(deriveAuthority({source}), {decision:"EVIDENCE_OR_PROPOSAL_ONLY",authoritativeStateChanged:false});
});

test("evidence corrections append amendments and preserve originals", () => {
  const result = amendEvidence({id:"syn_evidence_1",amendmentCount:0},{originalId:"syn_evidence_1",overwrite:false,value:"SYNTHETIC_CORRECTION"});
  assert.equal(result.originalPreserved, true);
  assert.throws(() => amendEvidence({id:"syn_evidence_1",amendmentCount:0},{originalId:"syn_evidence_1",overwrite:true}), /append-only/);
});

test("issued financial facts use adjustment or void rather than overwrite", () => {
  assert.throws(() => correctIssuedFinancialFact({id:"syn_invoice_1",state:"ISSUED"},{kind:"OVERWRITE"}), /adjustment or void/);
  assert.equal(correctIssuedFinancialFact({id:"syn_invoice_1",state:"ISSUED"},{kind:"ADJUSTMENT"}).originalPreserved, true);
});

test("billing readiness requires outcome, authorization, rate, policy, and evidence", () => {
  const ready = {eligibleOutcome:true,outcome:"COMPLETED",authorizationRef:"syn_auth_1",rateRef:"syn_rate_1",policyVersion:"SYN_POLICY_1",requiredEvidencePassed:true};
  assert.equal(evaluateBillingReadiness(ready).decision, "READY");
  for (const missing of ["eligibleOutcome","authorizationRef","rateRef","policyVersion","requiredEvidencePassed"]) {
    const invalid = {...ready}; invalid[missing] = missing === "eligibleOutcome" || missing === "requiredEvidencePassed" ? false : null;
    assert.equal(evaluateBillingReadiness(invalid).decision, "HOLD");
  }
});

test("no-show and cancellation compensation requires explicit effective policy", () => {
  const input = {eligibleOutcome:true,outcome:"RIDER_NO_SHOW",authorizationRef:"syn_auth_1",rateRef:"syn_rate_1",policyVersion:"SYN_POLICY_1",requiredEvidencePassed:true};
  assert.equal(evaluateBillingReadiness(input).reason, "EFFECTIVE_COMPENSATION_POLICY_REQUIRED");
  assert.equal(evaluateBillingReadiness({...input,compensationPolicy:{explicitlyEligible:true}}).decision, "READY");
});

test("always-hard invariants cannot be converted into overrides", () => {
  const invalid = structuredClone(bundle.constraints); invalid.constraints.find((x) => x.id === "TENANT_SCOPE").override = "AUTHORIZED_WITH_AUDIT";
  assert.throws(() => validateConstraints(invalid), /cannot be overridden/);
});

test("all seven requested operational topics remain provisional and customer-independent", () => {
  for (const topic of ["WAIT_DURATION","LATE_TOLERANCE","NO_SHOW_COMPENSATION","DOCUMENTATION","MODE","SERVICE_AREA","AUTHORIZATION"]) assert.ok(bundle.policies.fixtures.some((x) => x.topic === topic));
  const invalid = structuredClone(bundle.policies); invalid.fixtures[0].customerName = "Synthetic Customer";
  assert.throws(() => validatePolicies(invalid), /customer-name/);
});

test("command and event envelopes require tenant, version, actor, causation, and policy metadata", () => {
  const command = {commandId:"syn_command_1",tenantId:"syn_tenant_alpha",aggregateType:"LEG_EXECUTION",aggregateId:"syn_leg_1",expectedAggregateVersion:2,idempotencyKey:"syn_key_1",actorType:"WORKFORCE",actorId:"syn_actor_1",occurredAt:"2026-08-24T00:00:00Z",source:"SYNTHETIC_TEST",correlationId:"syn_corr_1",causationId:"syn_cause_1",schemaVersion:"1.0.0",classificationIds:["INTERNAL"],policyVersion:"SYN_POLICY_1",commandType:"BoardRider"};
  assert.doesNotThrow(() => validateCommandEnvelope(command,bundle.catalog));
  const generic = {...command,commandType:"SetStatus"}; assert.throws(() => validateCommandEnvelope(generic,bundle.catalog), /generic status/);
  const event = {eventId:"syn_event_1",tenantId:"syn_tenant_alpha",aggregateType:"LEG_EXECUTION",aggregateId:"syn_leg_1",aggregateVersion:3,eventType:"RiderBoarded",schemaVersion:"1.0.0",occurredAt:"2026-08-24T00:00:00Z",recordedAt:"2026-08-24T00:00:01Z",actorType:"WORKFORCE",actorId:"syn_actor_1",commandId:"syn_command_1",idempotencyKey:"syn_key_1",correlationId:"syn_corr_1",causationId:"syn_cause_1",source:"SYNTHETIC_TEST",classificationIds:["INTERNAL"],policyVersion:"SYN_POLICY_1"};
  assert.doesNotThrow(() => validateEventEnvelope(event,bundle.catalog));
  assert.throws(() => validateEventEnvelope({...event,referencedTenantId:"syn_tenant_beta"},bundle.catalog), /tenant mismatch/);
});

test("all sixteen independent golden failure and recovery cases pass", () => {
  assert.equal(validateGoldenScenarios(bundle.scenarios).scenarios.length, 16);
});

test("mutating a golden expected reason fails deterministic validation", () => {
  const invalid = structuredClone(bundle.scenarios); invalid.scenarios[0].acceptedRejectedResults[1].reason = "SILENT_SECOND_EFFECT";
  assert.throws(() => validateGoldenScenarios(invalid), /independent golden rule/);
});

test("machine validation rejects missing owner, unknown command, and event mismatch", () => {
  const noOwner = structuredClone(bundle.machines); noOwner.machines[0].ownerAggregate = "UNKNOWN";
  assert.throws(() => validateMachines(noOwner,bundle.aggregates,bundle.catalog), /unknown aggregate/);
  const unknownCommand = structuredClone(bundle.machines); unknownCommand.machines[0].transitions[0].command = "SetStatus";
  assert.throws(() => validateMachines(unknownCommand,bundle.aggregates,bundle.catalog), /unknown command/);
  const wrongEvent = structuredClone(bundle.machines); wrongEvent.machines[0].transitions[0].event = "WrongEvent";
  assert.throws(() => validateMachines(wrongEvent,bundle.aggregates,bundle.catalog), /must match catalog event/);
});
