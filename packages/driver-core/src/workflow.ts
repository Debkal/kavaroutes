export const INSPECTION_POLICY_VERSION = "inspection-synthetic-v2" as const;
export const ATTESTATION_POLICY_VERSION = "attestation-synthetic-v2" as const;

export const INSPECTION_ITEMS = Object.freeze([
  "Service and parking brakes", "Steering and suspension", "Horn", "Mirrors, cameras, and backup alarm",
  "Glass, wipers, washer, and defrost", "Lights, reflectors, signals, and hazards", "Tires, wheels, rims, lugs, and spare kit",
  "Engine, warnings, battery, fuel or charge, fluids, leaks, and exhaust", "Doors, locks, exits, steps, handrails, seats, headrests, and belts",
  "Heating, cooling, and ventilation", "Emergency, first-aid, spill, flashlight, and communication equipment",
  "Cleanliness, contamination, pests, odor, loose objects, body damage, and lost property",
  "Wheelchair lift, ramp, interlocks, manual backup, securement, tiedowns, and occupant restraints",
  "Stretcher mounts, oxygen storage, and configured specialty equipment", "Device mount, charger, navigation, and location",
  "Required vehicle documents", "Organization extension: sanitizing supplies", "Other unsafe condition",
  "Vehicle extension: configured specialty restraint", "Funding-source extension: required safety kit",
] as const);

export type ShiftPhase = "SIGNED_OUT" | "SHIFT_STARTING" | "POLICY_RESOLVED" | "PRECHECK_REQUIRED" | "PRECHECK_OFFERED" | "READY" | "ITINERARY_ACTIVE" |
  "RETURN_REQUIRED" | "POSTCHECK_REQUIRED" | "POSTCHECK_OFFERED" | "SIGNOFF_PENDING" | "SHIFT_ENDED" | "BLOCKED_CRITICAL_DEFECT" |
  "RETURN_LOCATION_EXCEPTION" | "EMERGENCY_STOPPED";
export type StopStep = "NAVIGATE" | "ARRIVED" | "VERIFY_RIDER" | "BOARD_AND_SECURE" | "SIGNATURE_REQUIRED" |
  "START_TRANSPORT" | "UNLOAD_AND_ASSIST" | "DROPOFF_EVIDENCE_REQUIRED" | "COMPLETE_LEG" | "COMPLETE";
export type InspectionResponse = "NO_DEFECT" | "DEFECT_FOUND" | "NOT_APPLICABLE";
export type DefectSeverity = "CRITICAL_OUT_OF_SERVICE" | "SERVICE_AFFECTING" | "MINOR";
export type SignerRole = "RIDER" | "GUARDIAN_OR_AUTHORIZED_REPRESENTATIVE" | "FACILITY_EMPLOYEE" | "DRIVER" | "RIDER_UNABLE_TO_SIGN";
export type ProposalState = "NONE" | "DRAFT" | "PENDING_DISPATCH_APPROVAL" | "APPROVED" | "REJECTED" | "EXPIRED" | "CONFLICT";
export type CommercialTier = "SMALL_BUSINESS" | "ENTERPRISE";
export type WorkforceRelationship = "OWNER_OPERATOR" | "EMPLOYEE" | "CONTRACTOR";
export type InspectionControlMode = "DISABLED" | "OPTIONAL" | "REQUIRED";
export type ReturnVerificationMode = "DISABLED" | "ADVISORY" | "REQUIRED_WITH_AUDITED_OVERRIDE";
export type RouteChangeMode = "AUTHORIZED_SELF_APPROVE" | "DISPATCH_APPROVAL_REQUIRED" | "DISABLED";
export interface DriverPolicyControl<TMode extends string> { readonly mode: TMode; readonly source: string; readonly reasonCode: string; readonly locked: boolean }
export interface DriverPolicySnapshot {
  readonly schemaVersion: 1; readonly organizationId: string; readonly driverId: string; readonly assignmentId: string;
  readonly commercialTier: CommercialTier; readonly workforceRelationship: WorkforceRelationship; readonly policyVersion: number; readonly resolvedAt: string;
  readonly preInspection: DriverPolicyControl<InspectionControlMode>; readonly postInspection: DriverPolicyControl<InspectionControlMode>;
  readonly startOdometer: DriverPolicyControl<InspectionControlMode>; readonly endOdometer: DriverPolicyControl<InspectionControlMode>;
  readonly returnVerification: DriverPolicyControl<ReturnVerificationMode>; readonly routeChange: DriverPolicyControl<RouteChangeMode>;
  readonly proofOfServicePolicy: "PAYER_CONTRACT_ORGANIZATION_RESOLVED"; readonly nonWaivableControls: readonly string[]; readonly canonicalDigest: string;
}
export type RouteViolation = "PICKUP_DROPOFF_INVERSION" | "ONBOARD_RIDER" | "STARTED_OR_COMPLETED" | "LOCKED_NODE" | "OTHER_DRIVER" |
  "MUTATES_RIDER_ADDRESS_SERVICE_OR_PAYER" | "TIME_WINDOW" | "MAXIMUM_RIDE" | "BREAK_OR_RETURN" | "CAPACITY" | "EQUIPMENT" | "QUALIFICATION";
export interface SignaturePoint { readonly x: number; readonly y: number }

export interface InspectionAnswer {
  readonly response: InspectionResponse;
  readonly severity?: DefectSeverity;
  readonly note?: string;
  readonly photoDigest?: string;
  readonly photoException?: "UNSAFE_TO_CAPTURE" | "CAMERA_UNAVAILABLE";
}
export interface SignatureEvidence {
  readonly evidenceId: string;
  readonly stopReference: string;
  readonly action: "PICKUP_ATTESTATION" | "DROPOFF_ATTESTATION";
  readonly role: SignerRole;
  readonly attestationPolicyVersion: typeof ATTESTATION_POLICY_VERSION;
  readonly capturedAt: string;
  readonly localActionAt: string;
  readonly installationGeneration: string;
  readonly shiftGeneration: string;
  readonly digest: string;
  readonly locationEvidence: "SEPARATE_NOT_CAPTURED";
  readonly state: "QUEUED" | "UPLOADED" | "ACCEPTED" | "REJECTED" | "SUPERSEDED";
  readonly unableReason?: "DECLINED" | "PHYSICALLY_UNABLE" | "NO_AUTHORIZED_SIGNER";
  readonly witnessedByDriver?: true;
}
export interface SyntheticWorkflow {
  readonly schemaVersion: 3;
  readonly phase: ShiftPhase;
  readonly shiftGeneration: string;
  readonly authoritativeVersion: number;
  readonly tracking: "STOPPED" | "STARTING" | "TRACKING" | "EMERGENCY_STOPPED";
  readonly moving: boolean;
  readonly vehicleConfirmed: boolean;
  readonly effectivePolicy?: DriverPolicySnapshot;
  readonly startOdometer?: number;
  readonly endOdometer?: number;
  readonly fuelLevel?: "EMPTY" | "QUARTER" | "HALF" | "THREE_QUARTERS" | "FULL";
  readonly preCheck: Readonly<Record<string, InspectionAnswer>>;
  readonly postCheck: Readonly<Record<string, InspectionAnswer>>;
  readonly preCheckComplete: boolean;
  readonly postCheckComplete: boolean;
  readonly preInspectionOutcome: "NOT_REQUIRED" | "PENDING" | "COMPLETED" | "SKIPPED";
  readonly startOdometerOutcome: "NOT_REQUIRED" | "PENDING" | "COMPLETED" | "SKIPPED";
  readonly postInspectionOutcome: "NOT_REQUIRED" | "PENDING" | "COMPLETED" | "SKIPPED";
  readonly endOdometerOutcome: "NOT_REQUIRED" | "PENDING" | "COMPLETED" | "SKIPPED";
  readonly currentNode: number;
  readonly stopStep: StopStep;
  readonly evidenceByNode: Readonly<Record<string, SignatureEvidence>>;
  readonly supersededEvidenceIds: readonly string[];
  readonly proposalState: ProposalState;
  readonly syncState: "OFFLINE_QUEUE_PENDING" | "UPLOADING" | "LIVE" | "CONFLICT";
  readonly stopException: "NONE" | "RIDER_NOT_PRESENT" | "RIDER_DECLINED" | "FACILITY_DELAY" | "SAFETY_CONCERN";
  readonly eventOutbox: readonly string[];
  readonly lastReceipt: string;
}

export const createSyntheticWorkflow = (): SyntheticWorkflow => Object.freeze({
  schemaVersion: 3, phase: "SIGNED_OUT", shiftGeneration: "shift_synthetic000001", authoritativeVersion: 1,
  tracking: "STOPPED", moving: false, vehicleConfirmed: false, preCheck: {}, postCheck: {}, preCheckComplete: false,
  postCheckComplete: false, preInspectionOutcome: "NOT_REQUIRED", startOdometerOutcome: "NOT_REQUIRED", postInspectionOutcome: "NOT_REQUIRED", endOdometerOutcome: "NOT_REQUIRED",
  currentNode: 0, stopStep: "NAVIGATE", evidenceByNode: {}, supersededEvidenceIds: [], proposalState: "NONE",
  syncState: "LIVE", stopException: "NONE", eventOutbox: [], lastReceipt: "No server receipt yet",
});

export const SYNTHETIC_ENTERPRISE_POLICY: DriverPolicySnapshot = Object.freeze({
  schemaVersion: 1, organizationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", driverId: "30000000-0000-4000-8000-000000000001",
  assignmentId: "40000000-0000-4000-8000-000000000001", commercialTier: "ENTERPRISE", workforceRelationship: "EMPLOYEE",
  policyVersion: 1, resolvedAt: "2026-08-27T12:00:00.000Z",
  preInspection: { mode: "REQUIRED", source: "TIER_DEFAULT", reasonCode: "ENTERPRISE_STRICT_DEFAULT", locked: true },
  postInspection: { mode: "REQUIRED", source: "TIER_DEFAULT", reasonCode: "ENTERPRISE_STRICT_DEFAULT", locked: true },
  startOdometer: { mode: "REQUIRED", source: "TIER_DEFAULT", reasonCode: "ENTERPRISE_STRICT_DEFAULT", locked: true },
  endOdometer: { mode: "REQUIRED", source: "TIER_DEFAULT", reasonCode: "ENTERPRISE_STRICT_DEFAULT", locked: true },
  returnVerification: { mode: "REQUIRED_WITH_AUDITED_OVERRIDE", source: "TIER_DEFAULT", reasonCode: "ENTERPRISE_STRICT_DEFAULT", locked: true },
  routeChange: { mode: "DISPATCH_APPROVAL_REQUIRED", source: "TIER_DEFAULT", reasonCode: "ENTERPRISE_STRICT_DEFAULT", locked: true },
  proofOfServicePolicy: "PAYER_CONTRACT_ORGANIZATION_RESOLVED", nonWaivableControls: ["IDENTITY_AND_AUTHORIZATION", "TENANT_ISOLATION", "ENCRYPTION_AND_AUDIT", "MINIMUM_NECESSARY", "NO_PHI_NAVIGATION", "TRACKING_TRANSPARENCY", "EMERGENCY_STOP"],
  canonicalDigest: "e7096a6f276bc091eaa41af566cee2280266656778c750876574851343054278",
} as const);

export const SYNTHETIC_SMALL_BUSINESS_POLICY: DriverPolicySnapshot = Object.freeze({
  schemaVersion: 1, organizationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", driverId: "30000000-0000-4000-8000-000000000001",
  assignmentId: "40000000-0000-4000-8000-000000000001", commercialTier: "SMALL_BUSINESS", workforceRelationship: "OWNER_OPERATOR",
  policyVersion: 1, resolvedAt: "2026-08-27T12:00:00.000Z",
  preInspection: { mode: "OPTIONAL", source: "TIER_DEFAULT", reasonCode: "SMALL_BUSINESS_OWNER_DEFAULT", locked: false },
  postInspection: { mode: "OPTIONAL", source: "TIER_DEFAULT", reasonCode: "SMALL_BUSINESS_OWNER_DEFAULT", locked: false },
  startOdometer: { mode: "OPTIONAL", source: "TIER_DEFAULT", reasonCode: "SMALL_BUSINESS_OWNER_DEFAULT", locked: false },
  endOdometer: { mode: "OPTIONAL", source: "TIER_DEFAULT", reasonCode: "SMALL_BUSINESS_OWNER_DEFAULT", locked: false },
  returnVerification: { mode: "ADVISORY", source: "TIER_DEFAULT", reasonCode: "SMALL_BUSINESS_OWNER_DEFAULT", locked: false },
  routeChange: { mode: "AUTHORIZED_SELF_APPROVE", source: "TIER_DEFAULT", reasonCode: "SMALL_BUSINESS_OWNER_DEFAULT", locked: false },
  proofOfServicePolicy: "PAYER_CONTRACT_ORGANIZATION_RESOLVED", nonWaivableControls: ["IDENTITY_AND_AUTHORIZATION", "TENANT_ISOLATION", "ENCRYPTION_AND_AUDIT", "MINIMUM_NECESSARY", "NO_PHI_NAVIGATION", "TRACKING_TRANSPARENCY", "EMERGENCY_STOP"],
  canonicalDigest: "6068b9e0739e5a333c57488b3af4c8e73d3cff8aba13c5fb804efd83d19ae04e",
} as const);

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value);
}

export function canonicalDriverPolicyDigestInput(policy: DriverPolicySnapshot): string {
  const { canonicalDigest: _canonicalDigest, ...unsigned } = policy;
  return canonical(unsigned);
}

export function restoreSyntheticWorkflow(value: unknown): SyntheticWorkflow {
  if (!value || typeof value !== "object") throw new Error("WORKFLOW_CHECKPOINT_INVALID");
  const raw = value as { readonly schemaVersion?: number };
  if (raw.schemaVersion === 2) return Object.freeze({ ...createSyntheticWorkflow(), lastReceipt: "The earlier test shift was closed because it had no server-pinned control policy. Start a new shift." });
  const candidate = value as Partial<SyntheticWorkflow>;
  if (candidate.schemaVersion !== 3 || typeof candidate.phase !== "string" || !Array.isArray(candidate.eventOutbox)) throw new Error("WORKFLOW_CHECKPOINT_INVALID");
  if (candidate.phase !== "SIGNED_OUT" && candidate.phase !== "SHIFT_STARTING" && (!candidate.effectivePolicy || !validatePolicySnapshot(candidate.effectivePolicy))) throw new Error("WORKFLOW_POLICY_SNAPSHOT_INVALID");
  return candidate as SyntheticWorkflow;
}

const receipt = (state: SyntheticWorkflow, patch: Partial<SyntheticWorkflow>, event?: string): SyntheticWorkflow => Object.freeze({
  ...state, ...patch, authoritativeVersion: state.authoritativeVersion + 1,
  eventOutbox: event ? [...state.eventOutbox, event] : state.eventOutbox,
  lastReceipt: `Synthetic server receipt v${state.authoritativeVersion + 1}`,
});
const fail = (code: string): never => { throw new Error(code); };
const validateOdometer = (value: number) => Number.isFinite(value) && Number.isInteger(value) && value >= 0 && value <= 9_999_999;
export function validateInspectionAnswer(answer: InspectionAnswer): boolean {
  if (answer.response !== "DEFECT_FOUND") return true;
  return Boolean(answer.severity && answer.note?.trim() && ((answer.photoDigest && /^[a-f0-9]{64}$/.test(answer.photoDigest)) || answer.photoException));
}
export function validateSignatureStroke(points: readonly SignaturePoint[]): boolean {
  if (points.length < 8 || points.length > 600) return false;
  let distance = 0; let valid = true; let minimumX = Infinity; let maximumX = -Infinity; let minimumY = Infinity; let maximumY = -Infinity;
  points.forEach((point, index) => { if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) { valid = false; return; } minimumX = Math.min(minimumX, point.x); maximumX = Math.max(maximumX, point.x); minimumY = Math.min(minimumY, point.y); maximumY = Math.max(maximumY, point.y);
    if (index > 0) distance += Math.hypot(point.x - points[index - 1]!.x, point.y - points[index - 1]!.y); });
  return valid && distance >= 40 && (maximumX - minimumX >= 20 || maximumY - minimumY >= 20);
}
export function inspectionComplete(answers: Readonly<Record<string, InspectionAnswer>>): boolean {
  return INSPECTION_ITEMS.every((item) => answers[item] && validateInspectionAnswer(answers[item]!));
}

function validatePolicySnapshot(policy: DriverPolicySnapshot): boolean {
  return policy.schemaVersion === 1 && ["SMALL_BUSINESS", "ENTERPRISE"].includes(policy.commercialTier)
    && ["OWNER_OPERATOR", "EMPLOYEE", "CONTRACTOR"].includes(policy.workforceRelationship)
    && Number.isInteger(policy.policyVersion) && policy.policyVersion > 0 && /^[a-f0-9]{64}$/.test(policy.canonicalDigest)
    && ["DISABLED", "OPTIONAL", "REQUIRED"].includes(policy.preInspection.mode)
    && ["DISABLED", "OPTIONAL", "REQUIRED"].includes(policy.postInspection.mode)
    && ["DISABLED", "OPTIONAL", "REQUIRED"].includes(policy.startOdometer.mode)
    && ["DISABLED", "OPTIONAL", "REQUIRED"].includes(policy.endOdometer.mode)
    && ["DISABLED", "ADVISORY", "REQUIRED_WITH_AUDITED_OVERRIDE"].includes(policy.returnVerification.mode)
    && ["AUTHORIZED_SELF_APPROVE", "DISPATCH_APPROVAL_REQUIRED", "DISABLED"].includes(policy.routeChange.mode);
}
const outcomeFor = (mode: InspectionControlMode) => mode === "DISABLED" ? "NOT_REQUIRED" as const : "PENDING" as const;
function gatePhase(inspection: InspectionControlMode, odometer: InspectionControlMode, required: ShiftPhase, offered: ShiftPhase, complete: ShiftPhase): ShiftPhase {
  if (inspection === "REQUIRED" || odometer === "REQUIRED") return required;
  if (inspection === "OPTIONAL" || odometer === "OPTIONAL") return offered;
  return complete;
}
function resolveControlOutcome(mode: InspectionControlMode, completed: boolean, skipped: boolean, incompleteCode: string): "NOT_REQUIRED" | "COMPLETED" | "SKIPPED" {
  if (mode === "DISABLED") { if (completed || skipped) fail("DISABLED_CONTROL_MUST_BE_OMITTED"); return "NOT_REQUIRED"; }
  if (completed) return "COMPLETED";
  if (mode === "OPTIONAL" && skipped) return "SKIPPED";
  return fail(incompleteCode);
}

export type WorkflowCommand =
  | { readonly type: "REQUEST_START_SHIFT" }
  | { readonly type: "START_SHIFT_ACCEPTED"; readonly effectivePolicy: DriverPolicySnapshot }
  | { readonly type: "START_SHIFT_FAILED"; readonly reason: "PERMISSION_DENIED" | "TRACKING_START_FAILED" }
  | { readonly type: "CONFIRM_VEHICLE" }
  | { readonly type: "ANSWER_INSPECTION"; readonly stage: "PRE" | "POST"; readonly item: string; readonly answer: InspectionAnswer }
  | { readonly type: "COMPLETE_PRECHECK"; readonly odometer?: number; readonly fuelLevel?: NonNullable<SyntheticWorkflow["fuelLevel"]>; readonly skip?: readonly ("INSPECTION" | "ODOMETER")[]; readonly reason?: "OPTIONAL_CONTROL_SKIPPED" }
  | { readonly type: "SKIP_PRECHECK"; readonly reason: "OPTIONAL_CONTROL_SKIPPED" }
  | { readonly type: "ADVANCE_STOP" }
  | { readonly type: "SAVE_SIGNATURE"; readonly evidence: SignatureEvidence }
  | { readonly type: "BEGIN_RETURN" }
  | { readonly type: "COMPLETE_POSTCHECK"; readonly odometer?: number; readonly fuelLevel?: NonNullable<SyntheticWorkflow["fuelLevel"]>; readonly skip?: readonly ("INSPECTION" | "ODOMETER")[]; readonly reason?: "OPTIONAL_CONTROL_SKIPPED" }
  | { readonly type: "SKIP_POSTCHECK"; readonly reason: "OPTIONAL_CONTROL_SKIPPED" }
  | { readonly type: "SIGN_OFF"; readonly location: "PASS" | "OUTSIDE" | "STALE" | "INACCURATE" | "UNAVAILABLE"; readonly override?: boolean }
  | { readonly type: "EMERGENCY_STOP"; readonly reason: "SAFETY" | "PRIVACY" | "DEVICE_PROBLEM" | "OTHER" }
  | { readonly type: "SET_MOVING"; readonly moving: boolean }
  | { readonly type: "REPORT_STOP_EXCEPTION"; readonly reason: Exclude<SyntheticWorkflow["stopException"], "NONE"> }
  | { readonly type: "BEGIN_PROPOSAL" }
  | { readonly type: "PROPOSE_REORDER"; readonly violation?: RouteViolation }
  | { readonly type: "DECIDE_PROPOSAL"; readonly decision: Exclude<ProposalState, "NONE" | "DRAFT" | "PENDING_DISPATCH_APPROVAL"> }
  | { readonly type: "SYNC_OUTBOX"; readonly outcome: "ACCEPTED" | "CONFLICT" | "OFFLINE" };

export function applyWorkflowCommand(state: SyntheticWorkflow, command: WorkflowCommand): SyntheticWorkflow {
  if (command.type === "SET_MOVING") return { ...state, moving: command.moving };
  if (command.type === "EMERGENCY_STOP") return receipt(state, { phase: "EMERGENCY_STOPPED", tracking: "EMERGENCY_STOPPED", moving: false }, `driver.tracking.emergency_stopped:${command.reason}`);
  if (state.moving && ["ANSWER_INSPECTION", "COMPLETE_PRECHECK", "SKIP_PRECHECK", "SAVE_SIGNATURE", "PROPOSE_REORDER", "BEGIN_PROPOSAL", "REPORT_STOP_EXCEPTION", "COMPLETE_POSTCHECK", "SKIP_POSTCHECK"].includes(command.type)) fail("PARK_VEHICLE_TO_CONTINUE");
  switch (command.type) {
    case "REQUEST_START_SHIFT":
      if (state.phase !== "SIGNED_OUT") fail("SHIFT_ALREADY_STARTED");
      return { ...state, phase: "SHIFT_STARTING", tracking: "STARTING", lastReceipt: "Waiting for synthetic server acceptance" };
    case "START_SHIFT_ACCEPTED":
      if (state.phase !== "SHIFT_STARTING") fail("SHIFT_START_NOT_PENDING");
      if (!validatePolicySnapshot(command.effectivePolicy)) fail("EFFECTIVE_POLICY_INVALID");
      return receipt(state, { phase: "POLICY_RESOLVED", tracking: "TRACKING", effectivePolicy: command.effectivePolicy,
        preInspectionOutcome: outcomeFor(command.effectivePolicy.preInspection.mode), startOdometerOutcome: outcomeFor(command.effectivePolicy.startOdometer.mode),
        postInspectionOutcome: outcomeFor(command.effectivePolicy.postInspection.mode), endOdometerOutcome: outcomeFor(command.effectivePolicy.endOdometer.mode) },
      "driver.shift.started|driver.tracking.started|driver.shift.policy_snapshotted");
    case "START_SHIFT_FAILED":
      if (state.phase !== "SHIFT_STARTING") fail("SHIFT_START_NOT_PENDING");
      return { ...state, phase: "SIGNED_OUT", tracking: "STOPPED", lastReceipt: `Shift not started: ${command.reason.toLowerCase().replaceAll("_", " ")}` };
    case "CONFIRM_VEHICLE":
      if (state.phase !== "POLICY_RESOLVED" || !state.effectivePolicy) fail("VEHICLE_CONFIRMATION_NOT_ALLOWED");
      return receipt(state, { vehicleConfirmed: true, phase: gatePhase(state.effectivePolicy!.preInspection.mode, state.effectivePolicy!.startOdometer.mode, "PRECHECK_REQUIRED", "PRECHECK_OFFERED", "READY") }, "driver.vehicle.confirmed");
    case "ANSWER_INSPECTION": {
      if (!INSPECTION_ITEMS.includes(command.item as typeof INSPECTION_ITEMS[number])) fail("INSPECTION_ITEM_UNKNOWN");
      if (!state.effectivePolicy) fail("EFFECTIVE_POLICY_REQUIRED");
      const policy = state.effectivePolicy!; const mode = command.stage === "PRE" ? policy.preInspection.mode : policy.postInspection.mode;
      if (mode === "DISABLED") fail("INSPECTION_DISABLED_BY_POLICY");
      if (command.stage === "PRE" && !["PRECHECK_REQUIRED", "PRECHECK_OFFERED"].includes(state.phase)) fail("PRECHECK_NOT_ACTIVE");
      if (command.stage === "POST" && !["POSTCHECK_REQUIRED", "POSTCHECK_OFFERED"].includes(state.phase)) fail("POSTCHECK_NOT_ACTIVE");
      if (!validateInspectionAnswer(command.answer)) fail("DEFECT_DETAILS_REQUIRED");
      const target = command.stage === "PRE" ? state.preCheck : state.postCheck;
      return { ...state, [command.stage === "PRE" ? "preCheck" : "postCheck"]: { ...target, [command.item]: command.answer } };
    }
    case "COMPLETE_PRECHECK": {
      if (!["PRECHECK_REQUIRED", "PRECHECK_OFFERED"].includes(state.phase) || !state.vehicleConfirmed || !state.effectivePolicy) fail("VEHICLE_CONFIRMATION_REQUIRED");
      const skip = new Set(command.skip ?? []); if (skip.size > 0 && command.reason !== "OPTIONAL_CONTROL_SKIPPED") fail("SKIP_REASON_REQUIRED");
      const inspectionDone = inspectionComplete(state.preCheck); const odometerDone = command.odometer !== undefined && command.fuelLevel !== undefined;
      if (odometerDone && !validateOdometer(command.odometer!)) fail("ODOMETER_INVALID");
      const policy = state.effectivePolicy!;
      const preInspectionOutcome = resolveControlOutcome(policy.preInspection.mode, inspectionDone, skip.has("INSPECTION"), "INSPECTION_INCOMPLETE");
      const startOdometerOutcome = resolveControlOutcome(policy.startOdometer.mode, odometerDone, skip.has("ODOMETER"), "ODOMETER_REQUIRED");
      const critical = Object.values(state.preCheck).some((answer) => answer.severity === "CRITICAL_OUT_OF_SERVICE");
      if (critical) return receipt(state, { phase: "BLOCKED_CRITICAL_DEFECT", ...(odometerDone ? { startOdometer: command.odometer, fuelLevel: command.fuelLevel } : {}), preInspectionOutcome, startOdometerOutcome }, "driver.vehicle.critical_defect_alerted");
      const skipped = preInspectionOutcome === "SKIPPED" || startOdometerOutcome === "SKIPPED";
      return receipt(state, { phase: "READY", preCheckComplete: inspectionDone, preInspectionOutcome, startOdometerOutcome,
        ...(odometerDone ? { startOdometer: command.odometer, fuelLevel: command.fuelLevel } : {}) }, skipped ? "driver.control.skipped:precheck" : "driver.vehicle.precheck.accepted");
    }
    case "SKIP_PRECHECK":
      return applyWorkflowCommand(state, { type: "COMPLETE_PRECHECK", skip: ["INSPECTION", "ODOMETER"], reason: command.reason });
    case "ADVANCE_STOP": {
      if (!["READY", "ITINERARY_ACTIVE"].includes(state.phase)) fail("PRECHECK_REQUIRED");
      const pickup = state.currentNode < 2;
      if (state.stopStep === "NAVIGATE") return receipt(state, { phase: "ITINERARY_ACTIVE", stopStep: pickup ? "SIGNATURE_REQUIRED" : "DROPOFF_EVIDENCE_REQUIRED" }, pickup ? "driver.stop.pickup_confirmed" : "driver.stop.dropoff_confirmed");
      const next: Record<StopStep, StopStep> = { NAVIGATE: "ARRIVED", ARRIVED: pickup ? "VERIFY_RIDER" : "UNLOAD_AND_ASSIST", VERIFY_RIDER: "BOARD_AND_SECURE",
        BOARD_AND_SECURE: "SIGNATURE_REQUIRED", SIGNATURE_REQUIRED: "START_TRANSPORT", START_TRANSPORT: "UNLOAD_AND_ASSIST",
        UNLOAD_AND_ASSIST: "DROPOFF_EVIDENCE_REQUIRED", DROPOFF_EVIDENCE_REQUIRED: "COMPLETE_LEG", COMPLETE_LEG: "COMPLETE", COMPLETE: "COMPLETE" };
      const nodeKey = `node_${state.currentNode}`;
      if (state.stopStep === "SIGNATURE_REQUIRED" && !state.evidenceByNode[nodeKey]) fail("PICKUP_EVIDENCE_REQUIRED");
      if (state.stopStep === "DROPOFF_EVIDENCE_REQUIRED" && !state.evidenceByNode[nodeKey]) fail("DROPOFF_EVIDENCE_REQUIRED");
      if (pickup && state.stopStep === "START_TRANSPORT") return receipt(state, { phase: "ITINERARY_ACTIVE", currentNode: state.currentNode + 1, stopStep: "NAVIGATE", moving: true }, "driver.stop.start_transport");
      if (!pickup && state.stopStep === "COMPLETE_LEG") return state.currentNode === 3
        ? receipt(state, { phase: "ITINERARY_ACTIVE", stopStep: "COMPLETE", moving: false }, "driver.stop.complete")
        : receipt(state, { phase: "ITINERARY_ACTIVE", currentNode: state.currentNode + 1, stopStep: "NAVIGATE", moving: true }, "driver.stop.complete_leg");
      const stopStep = next[state.stopStep];
      return receipt(state, { phase: "ITINERARY_ACTIVE", stopStep }, `driver.stop.${stopStep.toLowerCase()}`);
    }
    case "SAVE_SIGNATURE": {
      const expected = state.stopStep === "SIGNATURE_REQUIRED" ? "PICKUP_ATTESTATION" : state.stopStep === "DROPOFF_EVIDENCE_REQUIRED" ? "DROPOFF_ATTESTATION" : null;
      if (!expected || command.evidence.action !== expected) fail("SIGNATURE_NOT_ALLOWED");
      if (command.evidence.digest.length !== 64 || command.evidence.shiftGeneration !== state.shiftGeneration) fail("SIGNATURE_BINDING_INVALID");
      if (command.evidence.role === "RIDER_UNABLE_TO_SIGN" && (!command.evidence.unableReason || !command.evidence.witnessedByDriver)) fail("UNABLE_TO_SIGN_ATTESTATION_REQUIRED");
      if (Object.values(state.evidenceByNode).some((evidence) => evidence.evidenceId === command.evidence.evidenceId)) fail("SIGNATURE_REUSE_PROHIBITED");
      const expectedReference = `ref_synthetic_stop_${String(state.currentNode + 1).padStart(4, "0")}`;
      if (command.evidence.stopReference !== expectedReference) fail("SIGNATURE_BINDING_INVALID");
      const nodeKey = `node_${state.currentNode}`; const previous = state.evidenceByNode[nodeKey]; const lastNode = state.currentNode === 3;
      return receipt(state, {
        phase: "ITINERARY_ACTIVE",
        currentNode: lastNode ? state.currentNode : state.currentNode + 1,
        stopStep: lastNode ? "COMPLETE" : "NAVIGATE",
        moving: false,
        stopException: "NONE",
        evidenceByNode: { ...state.evidenceByNode, [nodeKey]: command.evidence },
        supersededEvidenceIds: previous ? [...state.supersededEvidenceIds, previous.evidenceId] : state.supersededEvidenceIds,
      }, `${previous ? "driver.evidence.superseded_and_queued" : "driver.evidence.queued"}|${lastNode ? "driver.stop.complete" : expected === "PICKUP_ATTESTATION" ? "driver.stop.start_transport" : "driver.stop.complete_leg"}`);
    }
    case "BEGIN_RETURN":
      if (state.stopStep !== "COMPLETE") fail("LAST_LEG_INCOMPLETE");
      if (!state.effectivePolicy) fail("EFFECTIVE_POLICY_REQUIRED");
      return receipt(state, { phase: gatePhase(state.effectivePolicy!.postInspection.mode, state.effectivePolicy!.endOdometer.mode, "POSTCHECK_REQUIRED", "POSTCHECK_OFFERED", "SIGNOFF_PENDING"), moving: false }, "driver.vehicle.returned");
    case "COMPLETE_POSTCHECK": {
      if (!["POSTCHECK_REQUIRED", "POSTCHECK_OFFERED"].includes(state.phase) || !state.effectivePolicy) fail("POSTCHECK_INCOMPLETE");
      const skip = new Set(command.skip ?? []); if (skip.size > 0 && command.reason !== "OPTIONAL_CONTROL_SKIPPED") fail("SKIP_REASON_REQUIRED");
      const inspectionDone = inspectionComplete(state.postCheck); const odometerDone = command.odometer !== undefined && command.fuelLevel !== undefined;
      if (odometerDone && (!validateOdometer(command.odometer!) || command.odometer! < (state.startOdometer ?? 0))) fail("END_ODOMETER_INVALID");
      const policy = state.effectivePolicy!;
      const postInspectionOutcome = resolveControlOutcome(policy.postInspection.mode, inspectionDone, skip.has("INSPECTION"), "POSTCHECK_INCOMPLETE");
      const endOdometerOutcome = resolveControlOutcome(policy.endOdometer.mode, odometerDone, skip.has("ODOMETER"), "END_ODOMETER_REQUIRED");
      const skipped = postInspectionOutcome === "SKIPPED" || endOdometerOutcome === "SKIPPED";
      return receipt(state, { phase: "SIGNOFF_PENDING", postCheckComplete: inspectionDone, postInspectionOutcome, endOdometerOutcome,
        ...(odometerDone ? { endOdometer: command.odometer, fuelLevel: command.fuelLevel } : {}) }, skipped ? "driver.control.skipped:postcheck" : "driver.vehicle.postcheck.accepted");
    }
    case "SKIP_POSTCHECK":
      return applyWorkflowCommand(state, { type: "COMPLETE_POSTCHECK", skip: ["INSPECTION", "ODOMETER"], reason: command.reason });
    case "SIGN_OFF":
      if ((state.phase !== "SIGNOFF_PENDING" && state.phase !== "RETURN_LOCATION_EXCEPTION") || !state.effectivePolicy) fail("SIGNOFF_NOT_ALLOWED");
      if (state.effectivePolicy!.returnVerification.mode === "DISABLED" && command.location !== "UNAVAILABLE") fail("RETURN_SAMPLE_PROHIBITED_BY_POLICY");
      if (state.effectivePolicy!.returnVerification.mode === "ADVISORY" && command.location !== "PASS") return receipt(state, { phase: "SHIFT_ENDED", tracking: "STOPPED", moving: false }, `vehicle_return_location_advisory:${command.location}|driver.shift.ended|driver.tracking.stopped`);
      if (state.effectivePolicy!.returnVerification.mode === "REQUIRED_WITH_AUDITED_OVERRIDE" && command.location !== "PASS" && !command.override) return receipt(state, { phase: "RETURN_LOCATION_EXCEPTION" }, `vehicle_return_location_exception:${command.location}`);
      return receipt(state, { phase: "SHIFT_ENDED", tracking: "STOPPED", moving: false }, "driver.shift.ended|driver.tracking.stopped");
    case "REPORT_STOP_EXCEPTION":
      return receipt(state, { stopException: command.reason }, `driver.stop.exception_reported:${command.reason}`);
    case "BEGIN_PROPOSAL":
      if (!state.effectivePolicy) fail("EFFECTIVE_POLICY_REQUIRED");
      if (state.effectivePolicy!.routeChange.mode === "DISABLED") fail("ROUTE_CHANGE_DISABLED_BY_POLICY");
      return { ...state, proposalState: "DRAFT", lastReceipt: "Route proposal draft is local and has not changed the itinerary" };
    case "PROPOSE_REORDER":
      if (state.proposalState !== "DRAFT") fail("PROPOSAL_DRAFT_REQUIRED");
      if (!state.effectivePolicy) fail("EFFECTIVE_POLICY_REQUIRED");
      if (command.violation) return receipt(state, { proposalState: "CONFLICT" }, `driver.route_proposal.rejected_invariant:${command.violation}`);
      if (state.effectivePolicy!.routeChange.mode === "DISABLED") return receipt(state, { proposalState: "REJECTED" }, "driver.route_proposal.disabled");
      return receipt(state, { proposalState: state.effectivePolicy!.routeChange.mode === "DISPATCH_APPROVAL_REQUIRED" ? "PENDING_DISPATCH_APPROVAL" : "APPROVED" }, state.effectivePolicy!.routeChange.mode === "DISPATCH_APPROVAL_REQUIRED" ? "driver.route_proposal.pending" : "driver.route_proposal.autoapproved");
    case "DECIDE_PROPOSAL":
      if (state.proposalState !== "PENDING_DISPATCH_APPROVAL") fail("PROPOSAL_NOT_PENDING");
      return receipt(state, { proposalState: command.decision }, `driver.route_proposal.${command.decision.toLowerCase()}`);
    case "SYNC_OUTBOX":
      if (command.outcome === "CONFLICT") return { ...state, syncState: "CONFLICT", lastReceipt: "Synthetic server reported a version conflict; authoritative itinerary preserved" };
      if (command.outcome === "OFFLINE") return { ...state, syncState: "OFFLINE_QUEUE_PENDING", lastReceipt: "Updates remain protected on this phone" };
      return { ...state, syncState: "LIVE", eventOutbox: [], evidenceByNode: Object.fromEntries(Object.entries(state.evidenceByNode).map(([key, evidence]) => [key, { ...evidence, state: "ACCEPTED" as const }])), lastReceipt: "Synthetic server accepted queued updates" };
  }
}

export function actionLabel(step: StopStep, nodeKind: "PICKUP" | "DROPOFF" = "PICKUP"): string {
  return ({ NAVIGATE: `Confirm ${nodeKind === "PICKUP" ? "pickup" : "drop-off"}`, ARRIVED: `I have arrived at ${nodeKind === "PICKUP" ? "pickup" : "drop-off"}`, VERIFY_RIDER: "Verify the rider", BOARD_AND_SECURE: "Rider and equipment are secure",
    SIGNATURE_REQUIRED: "Collect pickup signature", START_TRANSPORT: "Start transporting", UNLOAD_AND_ASSIST: "Rider safely unloaded",
    DROPOFF_EVIDENCE_REQUIRED: "Collect drop-off signature", COMPLETE_LEG: "Complete this leg", COMPLETE: "Leg complete" })[step];
}
