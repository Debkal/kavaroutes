import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { ATTESTATION_POLICY_VERSION, INSPECTION_ITEMS, SYNTHETIC_ENTERPRISE_POLICY, SYNTHETIC_SMALL_BUSINESS_POLICY, applyWorkflowCommand, canonicalDriverPolicyDigestInput, createSyntheticWorkflow, restoreSyntheticWorkflow, validateInspectionAnswer, validateSignatureStroke } from "../dist/workflow.js";

const noDefects = (state, stage = "PRE") => INSPECTION_ITEMS.reduce((current, item) => applyWorkflowCommand(current,
  { type: "ANSWER_INSPECTION", stage, item, answer: { response: "NO_DEFECT" } }), state);
const policy = (overrides = {}) => ({ ...SYNTHETIC_ENTERPRISE_POLICY, canonicalDigest: "b".repeat(64), ...overrides });
const startShift = (state = createSyntheticWorkflow(), effectivePolicy = SYNTHETIC_ENTERPRISE_POLICY) => applyWorkflowCommand(applyWorkflowCommand(state, { type: "REQUEST_START_SHIFT" }), { type: "START_SHIFT_ACCEPTED", effectivePolicy });
const draftProposal = (state = { ...createSyntheticWorkflow(), effectivePolicy: SYNTHETIC_ENTERPRISE_POLICY }) => applyWorkflowCommand(state, { type: "BEGIN_PROPOSAL" });
const signature = (state, action, id) => ({ evidenceId: id, stopReference: `ref_synthetic_stop_${String(state.currentNode + 1).padStart(4, "0")}`, action, role: "RIDER",
  attestationPolicyVersion: ATTESTATION_POLICY_VERSION, capturedAt: "2026-08-26T12:00:00.000Z", localActionAt: "2026-08-26T12:00:00.000Z",
  installationGeneration: "inst_synthetic0000001", shiftGeneration: state.shiftGeneration, digest: "a".repeat(64),
  locationEvidence: "SEPARATE_NOT_CAPTURED", state: "QUEUED" });

test("revised workflow completes one connected shift and never skips evidence", () => {
  let state = createSyntheticWorkflow();
  state = startShift(state);
  assert.equal(state.phase, "POLICY_RESOLVED"); assert.equal(state.tracking, "TRACKING");
  state = applyWorkflowCommand(state, { type: "CONFIRM_VEHICLE" }); assert.equal(state.phase, "PRECHECK_REQUIRED"); state = noDefects(state);
  state = applyWorkflowCommand(state, { type: "COMPLETE_PRECHECK", odometer: 10420, fuelLevel: "FULL" });
  for (let node = 0; node < 4; node++) {
    const pickup = node < 2; const stepsToEvidence = pickup ? 4 : 3;
    for (let count = 0; count < stepsToEvidence; count++) state = applyWorkflowCommand(state, { type: "ADVANCE_STOP" });
    assert.equal(state.stopStep, pickup ? "SIGNATURE_REQUIRED" : "DROPOFF_EVIDENCE_REQUIRED");
    assert.throws(() => applyWorkflowCommand(state, { type: "ADVANCE_STOP" }), pickup ? /PICKUP_EVIDENCE_REQUIRED/ : /DROPOFF_EVIDENCE_REQUIRED/);
    state = applyWorkflowCommand(state, { type: "SAVE_SIGNATURE", evidence: signature(state, pickup ? "PICKUP_ATTESTATION" : "DROPOFF_ATTESTATION", `evd_syntheticnode000${node}`) });
    if (node < 3) { assert.equal(state.currentNode, node + 1); assert.equal(state.stopStep, "NAVIGATE"); assert.equal(state.moving, true); state = applyWorkflowCommand(state, { type: "SET_MOVING", moving: false }); }
  }
  assert.equal(Object.keys(state.evidenceByNode).length, 4); assert.equal(state.stopStep, "COMPLETE");
  state = applyWorkflowCommand(state, { type: "BEGIN_RETURN" }); state = noDefects(state, "POST");
  assert.throws(() => applyWorkflowCommand(state, { type: "COMPLETE_POSTCHECK", odometer: 100, fuelLevel: "HALF" }), /END_ODOMETER_INVALID/);
  state = applyWorkflowCommand(state, { type: "COMPLETE_POSTCHECK", odometer: 10449, fuelLevel: "HALF" });
  state = applyWorkflowCommand(state, { type: "SIGN_OFF", location: "PASS" });
  assert.equal(state.phase, "SHIFT_ENDED"); assert.equal(state.tracking, "STOPPED");
  assert.match(state.eventOutbox.join(" "), /driver.shift.started/); assert.match(state.eventOutbox.join(" "), /driver.shift.ended/);
});

test("critical defect blocks release and moving state blocks complex work", () => {
  let state = startShift();
  state = applyWorkflowCommand(state, { type: "CONFIRM_VEHICLE" }); state = noDefects(state);
  state = applyWorkflowCommand(state, { type: "ANSWER_INSPECTION", stage: "PRE", item: INSPECTION_ITEMS[0], answer: {
    response: "DEFECT_FOUND", severity: "CRITICAL_OUT_OF_SERVICE", note: "Synthetic brake test failed", photoException: "UNSAFE_TO_CAPTURE" } });
  state = applyWorkflowCommand(state, { type: "COMPLETE_PRECHECK", odometer: 10, fuelLevel: "FULL" });
  assert.equal(state.phase, "BLOCKED_CRITICAL_DEFECT"); assert.match(state.eventOutbox.at(-1), /critical_defect_alerted/);
  const moving = applyWorkflowCommand(createSyntheticWorkflow(), { type: "SET_MOVING", moving: true });
  assert.throws(() => applyWorkflowCommand(moving, { type: "BEGIN_PROPOSAL" }), /PARK_VEHICLE_TO_CONTINUE/);
});

test("route proposals remain receipt-controlled for both tiers and invalid order conflicts", () => {
  let enterprise = applyWorkflowCommand(draftProposal(), { type: "PROPOSE_REORDER" });
  assert.equal(enterprise.proposalState, "PENDING_DISPATCH_APPROVAL");
  enterprise = applyWorkflowCommand(enterprise, { type: "DECIDE_PROPOSAL", decision: "APPROVED" });
  assert.equal(enterprise.proposalState, "APPROVED");
  for (const violation of ["PICKUP_DROPOFF_INVERSION", "ONBOARD_RIDER", "STARTED_OR_COMPLETED", "LOCKED_NODE", "OTHER_DRIVER", "MUTATES_RIDER_ADDRESS_SERVICE_OR_PAYER", "TIME_WINDOW", "MAXIMUM_RIDE", "BREAK_OR_RETURN", "CAPACITY", "EQUIPMENT", "QUALIFICATION"])
    assert.equal(applyWorkflowCommand(draftProposal(), { type: "PROPOSE_REORDER", violation }).proposalState, "CONFLICT");
  const smallSelf = { ...createSyntheticWorkflow(), effectivePolicy: policy({ commercialTier: "SMALL_BUSINESS", workforceRelationship: "OWNER_OPERATOR", routeChange: { mode: "AUTHORIZED_SELF_APPROVE", source: "TIER_DEFAULT", reasonCode: "SMALL_BUSINESS_OWNER_DEFAULT", locked: false } }) };
  assert.equal(applyWorkflowCommand(draftProposal(smallSelf), { type: "PROPOSE_REORDER" }).proposalState, "APPROVED");
  const smallDispatch = { ...smallSelf, effectivePolicy: policy({ commercialTier: "SMALL_BUSINESS", workforceRelationship: "OWNER_OPERATOR", routeChange: { mode: "DISPATCH_APPROVAL_REQUIRED", source: "TIER_DEFAULT", reasonCode: "SELF_APPROVAL_CAPABILITY_MISSING", locked: false } }) };
  assert.equal(applyWorkflowCommand(draftProposal(smallDispatch), { type: "PROPOSE_REORDER" }).proposalState, "PENDING_DISPATCH_APPROVAL");
  const disabled = { ...smallSelf, effectivePolicy: policy({ commercialTier: "SMALL_BUSINESS", routeChange: { mode: "DISABLED", source: "ORGANIZATION_LOCK", reasonCode: "ORGANIZATION_LOCK_APPLIED", locked: true } }) };
  assert.throws(() => draftProposal(disabled), /ROUTE_CHANGE_DISABLED_BY_POLICY/);
  for (const decision of ["REJECTED", "EXPIRED", "CONFLICT"]) {
    const pending = applyWorkflowCommand(draftProposal(), { type: "PROPOSE_REORDER" });
    assert.equal(applyWorkflowCommand(pending, { type: "DECIDE_PROPOSAL", decision }).proposalState, decision);
  }
});

test("return exceptions use neutral state, override is explicit, and emergency stop always ends collection", () => {
  let state;
  for (const location of ["OUTSIDE", "STALE", "INACCURATE", "UNAVAILABLE"]) {
    state = applyWorkflowCommand({ ...createSyntheticWorkflow(), effectivePolicy: SYNTHETIC_ENTERPRISE_POLICY, phase: "SIGNOFF_PENDING", tracking: "TRACKING", postCheckComplete: true }, { type: "SIGN_OFF", location });
    assert.equal(state.phase, "RETURN_LOCATION_EXCEPTION"); assert.equal(state.tracking, "TRACKING");
  }
  state = applyWorkflowCommand(state, { type: "SIGN_OFF", location: "STALE", override: true });
  assert.equal(state.phase, "SHIFT_ENDED"); assert.equal(state.tracking, "STOPPED");
  const stopped = applyWorkflowCommand({ ...createSyntheticWorkflow(), tracking: "TRACKING" }, { type: "EMERGENCY_STOP", reason: "PRIVACY" });
  assert.equal(stopped.phase, "EMERGENCY_STOPPED"); assert.equal(stopped.tracking, "EMERGENCY_STOPPED");
});

test("signature evidence cannot be reused and unable-to-sign is explicitly witnessed", () => {
  let state = { ...createSyntheticWorkflow(), phase: "ITINERARY_ACTIVE", preCheckComplete: true, stopStep: "SIGNATURE_REQUIRED" };
  const unable = { ...signature(state, "PICKUP_ATTESTATION", "evd_syntheticunable0001"), role: "RIDER_UNABLE_TO_SIGN", unableReason: "PHYSICALLY_UNABLE", witnessedByDriver: true };
  state = applyWorkflowCommand(state, { type: "SAVE_SIGNATURE", evidence: unable });
  assert.equal(state.currentNode, 1); assert.equal(state.stopStep, "NAVIGATE"); assert.match(state.eventOutbox.at(-1), /driver\.stop\.start_transport/);
  const atDropoff = { ...state, currentNode: 2, stopStep: "DROPOFF_EVIDENCE_REQUIRED", moving: false };
  assert.throws(() => applyWorkflowCommand(atDropoff, { type: "SAVE_SIGNATURE", evidence: { ...unable, action: "DROPOFF_ATTESTATION" } }), /SIGNATURE_REUSE_PROHIBITED/);
  const missingWitness = { ...createSyntheticWorkflow(), phase: "ITINERARY_ACTIVE", preCheckComplete: true, stopStep: "SIGNATURE_REQUIRED" };
  assert.throws(() => applyWorkflowCommand(missingWitness, { type: "SAVE_SIGNATURE", evidence: { ...signature(missingWitness, "PICKUP_ATTESTATION", "evd_syntheticmissing001"), role: "RIDER_UNABLE_TO_SIGN" } }), /UNABLE_TO_SIGN_ATTESTATION_REQUIRED/);
  for (const role of ["RIDER", "GUARDIAN_OR_AUTHORIZED_REPRESENTATIVE", "FACILITY_EMPLOYEE", "DRIVER"]) {
    const fresh = { ...createSyntheticWorkflow(), phase: "ITINERARY_ACTIVE", preCheckComplete: true, stopStep: "SIGNATURE_REQUIRED" };
    assert.equal(applyWorkflowCommand(fresh, { type: "SAVE_SIGNATURE", evidence: { ...signature(fresh, "PICKUP_ATTESTATION", `evd_${role.toLowerCase().replaceAll("_", "").padEnd(24, "0").slice(0, 24)}`), role } }).evidenceByNode.node_0.role, role);
  }
  const retryBase = { ...createSyntheticWorkflow(), phase: "ITINERARY_ACTIVE", preCheckComplete: true, stopStep: "SIGNATURE_REQUIRED" };
  const previous = signature(retryBase, "PICKUP_ATTESTATION", "evd_syntheticretry000001");
  const retryWithPrevious = { ...retryBase, evidenceByNode: { node_0: previous } };
  const second = applyWorkflowCommand(retryWithPrevious, { type: "SAVE_SIGNATURE", evidence: signature(retryWithPrevious, "PICKUP_ATTESTATION", "evd_syntheticretry000002") });
  assert.deepEqual(second.supersededEvidenceIds, ["evd_syntheticretry000001"]);
});

test("stop exceptions alert without fabricating completion and sync preserves conflict truth", () => {
  const active = { ...createSyntheticWorkflow(), phase: "ITINERARY_ACTIVE", preCheckComplete: true };
  for (const reason of ["RIDER_NOT_PRESENT", "RIDER_DECLINED", "FACILITY_DELAY", "SAFETY_CONCERN"]) {
    const reported = applyWorkflowCommand(active, { type: "REPORT_STOP_EXCEPTION", reason });
    assert.equal(reported.stopStep, "NAVIGATE"); assert.equal(reported.stopException, reason); assert.match(reported.eventOutbox.at(-1), /exception_reported/);
  }
  const conflict = applyWorkflowCommand({ ...active, eventOutbox: ["synthetic"] }, { type: "SYNC_OUTBOX", outcome: "CONFLICT" });
  assert.equal(conflict.syncState, "CONFLICT"); assert.equal(conflict.eventOutbox.length, 1);
});

test("inspection defects, odometer entry, stroke quality, and restart checkpoint shape fail closed", () => {
  assert.equal(INSPECTION_ITEMS.length, 20);
  assert.equal(validateInspectionAnswer({ response: "DEFECT_FOUND", severity: "MINOR", note: "Synthetic damage" }), false);
  assert.equal(validateInspectionAnswer({ response: "DEFECT_FOUND", severity: "MINOR", note: "Synthetic damage", photoDigest: "b".repeat(64) }), true);
  assert.equal(validateSignatureStroke(Array.from({ length: 12 }, () => ({ x: 2, y: 2 }))), false);
  assert.equal(validateSignatureStroke(Array.from({ length: 12 }, (_, index) => ({ x: index * 5, y: index % 2 * 10 }))), true);
  let state = startShift(); state = applyWorkflowCommand(state, { type: "CONFIRM_VEHICLE" }); state = noDefects(state);
  for (const odometer of [NaN, -1, 1.5, 10_000_000]) assert.throws(() => applyWorkflowCommand(state, { type: "COMPLETE_PRECHECK", odometer, fuelLevel: "FULL" }), /ODOMETER_INVALID/);
  state = applyWorkflowCommand(state, { type: "COMPLETE_PRECHECK", odometer: 42, fuelLevel: "FULL" });
  assert.deepEqual(JSON.parse(JSON.stringify(state)), state);
});

test("shift start exposes pending state and permission failure never fabricates an active shift", () => {
  const pending = applyWorkflowCommand(createSyntheticWorkflow(), { type: "REQUEST_START_SHIFT" });
  assert.equal(pending.phase, "SHIFT_STARTING"); assert.equal(pending.tracking, "STARTING"); assert.match(pending.lastReceipt, /Waiting/);
  const failed = applyWorkflowCommand(pending, { type: "START_SHIFT_FAILED", reason: "PERMISSION_DENIED" });
  assert.equal(failed.phase, "SIGNED_OUT"); assert.equal(failed.tracking, "STOPPED"); assert.equal(failed.eventOutbox.length, 0);
});

test("pinned policy drives required optional and disabled controls without fake completion", () => {
  const optionalPolicy = policy({ commercialTier: "SMALL_BUSINESS", workforceRelationship: "OWNER_OPERATOR",
    preInspection: { mode: "OPTIONAL", source: "TIER_DEFAULT", reasonCode: "SMALL_BUSINESS_OWNER_DEFAULT", locked: false },
    startOdometer: { mode: "OPTIONAL", source: "TIER_DEFAULT", reasonCode: "SMALL_BUSINESS_OWNER_DEFAULT", locked: false },
    postInspection: { mode: "OPTIONAL", source: "TIER_DEFAULT", reasonCode: "SMALL_BUSINESS_OWNER_DEFAULT", locked: false },
    endOdometer: { mode: "OPTIONAL", source: "TIER_DEFAULT", reasonCode: "SMALL_BUSINESS_OWNER_DEFAULT", locked: false },
    returnVerification: { mode: "ADVISORY", source: "TIER_DEFAULT", reasonCode: "SMALL_BUSINESS_OWNER_DEFAULT", locked: false } });
  let optional = startShift(createSyntheticWorkflow(), optionalPolicy);
  optional = applyWorkflowCommand(optional, { type: "CONFIRM_VEHICLE" }); assert.equal(optional.phase, "PRECHECK_OFFERED");
  optional = applyWorkflowCommand(optional, { type: "SKIP_PRECHECK", reason: "OPTIONAL_CONTROL_SKIPPED" });
  assert.equal(optional.phase, "READY"); assert.equal(optional.preCheckComplete, false); assert.equal(optional.preInspectionOutcome, "SKIPPED"); assert.equal(optional.startOdometerOutcome, "SKIPPED");
  assert.match(optional.eventOutbox.at(-1), /driver.control.skipped/);

  const disabledPolicy = policy({ commercialTier: "ENTERPRISE", workforceRelationship: "OWNER_OPERATOR",
    preInspection: { mode: "DISABLED", source: "ORGANIZATION_CONFIGURATION", reasonCode: "ORGANIZATION_CONFIGURATION_APPLIED", locked: false },
    startOdometer: { mode: "DISABLED", source: "ORGANIZATION_CONFIGURATION", reasonCode: "ORGANIZATION_CONFIGURATION_APPLIED", locked: false },
    postInspection: { mode: "DISABLED", source: "ORGANIZATION_CONFIGURATION", reasonCode: "ORGANIZATION_CONFIGURATION_APPLIED", locked: false },
    endOdometer: { mode: "DISABLED", source: "ORGANIZATION_CONFIGURATION", reasonCode: "ORGANIZATION_CONFIGURATION_APPLIED", locked: false },
    returnVerification: { mode: "DISABLED", source: "ORGANIZATION_CONFIGURATION", reasonCode: "ORGANIZATION_CONFIGURATION_APPLIED", locked: false } });
  let modularEnterprise = startShift(createSyntheticWorkflow(), disabledPolicy);
  modularEnterprise = applyWorkflowCommand(modularEnterprise, { type: "CONFIRM_VEHICLE" }); assert.equal(modularEnterprise.phase, "READY");
  assert.equal(modularEnterprise.preInspectionOutcome, "NOT_REQUIRED"); assert.equal(modularEnterprise.preCheckComplete, false);
  assert.throws(() => applyWorkflowCommand({ ...modularEnterprise, phase: "PRECHECK_OFFERED" }, { type: "COMPLETE_PRECHECK", odometer: 1, fuelLevel: "FULL" }), /DISABLED_CONTROL/);
  const atReturn = applyWorkflowCommand({ ...modularEnterprise, phase: "ITINERARY_ACTIVE", stopStep: "COMPLETE" }, { type: "BEGIN_RETURN" });
  assert.equal(atReturn.phase, "SIGNOFF_PENDING");
  assert.throws(() => applyWorkflowCommand(atReturn, { type: "SIGN_OFF", location: "PASS" }), /RETURN_SAMPLE_PROHIBITED/);
  assert.equal(applyWorkflowCommand(atReturn, { type: "SIGN_OFF", location: "UNAVAILABLE" }).phase, "SHIFT_ENDED");
});

test("policy checkpoint migration fails closed and active shifts require a valid pinned digest", () => {
  assert.equal(createHash("sha256").update(canonicalDriverPolicyDigestInput(SYNTHETIC_ENTERPRISE_POLICY)).digest("hex"), SYNTHETIC_ENTERPRISE_POLICY.canonicalDigest);
  assert.equal(createHash("sha256").update(canonicalDriverPolicyDigestInput(SYNTHETIC_SMALL_BUSINESS_POLICY)).digest("hex"), SYNTHETIC_SMALL_BUSINESS_POLICY.canonicalDigest);
  const legacy = restoreSyntheticWorkflow({ ...createSyntheticWorkflow(), schemaVersion: 2, phase: "ITINERARY_ACTIVE" });
  assert.equal(legacy.phase, "SIGNED_OUT"); assert.match(legacy.lastReceipt, /no server-pinned control policy/);
  assert.throws(() => restoreSyntheticWorkflow({ ...createSyntheticWorkflow(), phase: "READY" }), /WORKFLOW_POLICY_SNAPSHOT_INVALID/);
  assert.throws(() => applyWorkflowCommand(applyWorkflowCommand(createSyntheticWorkflow(), { type: "REQUEST_START_SHIFT" }), { type: "START_SHIFT_ACCEPTED", effectivePolicy: { ...SYNTHETIC_ENTERPRISE_POLICY, canonicalDigest: "client-selected" } }), /EFFECTIVE_POLICY_INVALID/);
});
