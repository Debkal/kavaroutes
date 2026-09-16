import type { DriverPrecheckReceipt, DriverPrecheckRequest, DriverShiftState } from "@kavaroutes/api-contracts/client-web";
import { INSPECTION_ITEMS, type SyntheticWorkflow, type WorkflowCommand } from "@kavaroutes/driver-core";

type PrecheckCommand = Extract<WorkflowCommand, { type: "COMPLETE_PRECHECK" | "SKIP_PRECHECK" }>;
export function buildCloudPrecheckRequest(state: SyntheticWorkflow, shift: DriverShiftState, vehicleId: string,
  command: PrecheckCommand | { type: "CONFIRM_VEHICLE" }, photos: DriverPrecheckRequest["photos"]): DriverPrecheckRequest {
  if (state.moving) throw new Error("PARK_VEHICLE_TO_CONTINUE");
  if (shift.lifecycle !== "ACTIVE" || state.shiftGeneration !== shift.shiftGeneration ||
    state.effectivePolicy?.canonicalDigest !== shift.effectivePolicy.canonicalDigest) throw new Error("SHIFT_POLICY_BINDING_CHANGED");
  const skip = command.type === "SKIP_PRECHECK" ? new Set(["INSPECTION", "ODOMETER"]) : new Set(command.type === "COMPLETE_PRECHECK" ? command.skip ?? [] : []);
  const skipped = { decision: "SKIPPED" as const, reason: "OPTIONAL_CONTROL_SKIPPED" as const };
  const policy = shift.effectivePolicy;
  if (skip.size && (command.type === "CONFIRM_VEHICLE" || command.reason !== "OPTIONAL_CONTROL_SKIPPED")) throw new Error("SKIP_REASON_REQUIRED");
  const inspection = policy.preInspection.mode === "DISABLED" ? undefined : skip.has("INSPECTION") ? skipped : {
    decision: "COMPLETED" as const, definitionVersion: "inspection-synthetic-v2" as const,
    entries: INSPECTION_ITEMS.map(item => {
      const answer = state.preCheck[item]; if (!answer) throw new Error("INSPECTION_INCOMPLETE");
      return { item, ...answer };
    }),
  };
  if (inspection?.decision === "SKIPPED" && Object.values(state.preCheck).some(answer => answer.response === "DEFECT_FOUND")) {
    throw new Error("REPORTED_DEFECT_MUST_BE_SUBMITTED");
  }
  const odometer = policy.startOdometer.mode === "DISABLED" ? undefined : skip.has("ODOMETER") ? skipped : command.type === "COMPLETE_PRECHECK" ? {
    decision: "COMPLETED" as const, value: command.odometer!, fuelLevel: command.fuelLevel!,
  } : undefined;
  if (inspection?.decision === "SKIPPED" && policy.preInspection.mode !== "OPTIONAL" || odometer?.decision === "SKIPPED" && policy.startOdometer.mode !== "OPTIONAL") throw new Error("REQUIRED_CONTROL_CANNOT_BE_SKIPPED");
  if (policy.startOdometer.mode !== "DISABLED" && !odometer || odometer?.decision === "COMPLETED" &&
    (!Number.isSafeInteger(odometer.value) || odometer.value < 0 || odometer.value > 9999999 || !odometer.fuelLevel)) throw new Error("ODOMETER_REQUIRED");
  return { shiftGeneration: shift.shiftGeneration, vehicleId, policyDigest: policy.canonicalDigest,
    expectedVersion: shift.resourceVersion, capturedAt: new Date().toISOString(), photos,
    ...(inspection ? { inspection } : {}), ...(odometer ? { odometer } : {}) };
}

export function adoptCloudPrecheck(state: SyntheticWorkflow, receipt: DriverPrecheckReceipt): SyntheticWorkflow {
  // Server result selects readiness; no local completion or synthetic receipt is applied.
  return { ...state, phase: receipt.vehicleState === "READY" ? "READY" : "BLOCKED_CRITICAL_DEFECT", vehicleConfirmed: true,
    preCheckComplete: receipt.inspectionOutcome === "COMPLETED", preInspectionOutcome: receipt.inspectionOutcome,
    startOdometerOutcome: receipt.odometerOutcome, authoritativeVersion: receipt.resourceVersion,
    ...(receipt.odometer !== null ? { startOdometer: receipt.odometer } : {}),
    ...(receipt.fuelLevel !== null ? { fuelLevel: receipt.fuelLevel as NonNullable<SyntheticWorkflow["fuelLevel"]> } : {}),
    lastReceipt: `Server vehicle decision v${receipt.resourceVersion}: ${receipt.vehicleState.replaceAll("_", " ")}` };
}
