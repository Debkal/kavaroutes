jest.mock("@kavaroutes/driver-core", () => jest.requireActual("../../../packages/driver-core/src/workflow"));
import { INSPECTION_ITEMS, createSyntheticWorkflow, SYNTHETIC_ENTERPRISE_POLICY } from "@kavaroutes/driver-core";
import type { DriverShiftState } from "@kavaroutes/api-contracts/client-web";
import { adoptCloudPrecheck, buildCloudPrecheckRequest } from "../src/cloud-precheck";

const shiftId = "50000000-0000-4000-8000-000000000001";
const generation = "50000000-0000-4000-8000-000000000002";
const vehicleId = "50000000-0000-4000-8000-000000000003";
const policy = SYNTHETIC_ENTERPRISE_POLICY;
const shift: DriverShiftState = { shiftReference: shiftId, shiftGeneration: generation, resourceVersion: 1, lifecycle: "ACTIVE",
  effectivePolicy: policy as DriverShiftState["effectivePolicy"], precheck: null };
const workflow = { ...createSyntheticWorkflow(), phase: "PRECHECK_REQUIRED" as const, vehicleConfirmed: true,
  shiftGeneration: generation, effectivePolicy: policy, preCheck: Object.fromEntries(INSPECTION_ITEMS.map(item => [item, { response: "NO_DEFECT" as const }])) };

test("completed check carries actual answers and numeric input, while readiness comes from server result", () => {
  const request = buildCloudPrecheckRequest(workflow, shift, vehicleId, { type: "COMPLETE_PRECHECK", odometer: 10420, fuelLevel: "FULL" }, []);
  expect(request.inspection).toMatchObject({ decision: "COMPLETED", entries: expect.arrayContaining([{ item: "Horn", response: "NO_DEFECT" }]) });
  expect(request.odometer).toEqual({ decision: "COMPLETED", value: 10420, fuelLevel: "FULL" });
  expect(workflow.phase).toBe("PRECHECK_REQUIRED");
  const accepted = adoptCloudPrecheck(workflow, { shiftReference: shiftId, vehicleId, resourceVersion: 2, inspectionOutcome: "COMPLETED",
    odometerOutcome: "COMPLETED", vehicleState: "BLOCKED_CRITICAL_DEFECT", odometer: 10420, fuelLevel: "FULL" });
  expect(accepted.phase).toBe("BLOCKED_CRITICAL_DEFECT");
  expect(accepted.lastReceipt).not.toMatch(/Synthetic/);
});

test("optional skip is explicit and disabled controls produce no fabricated evidence", () => {
  const optionalPolicy = { ...policy, preInspection: { ...policy.preInspection, mode: "OPTIONAL" as const }, startOdometer: { ...policy.startOdometer, mode: "OPTIONAL" as const } };
  const optionalShift = { ...shift, effectivePolicy: optionalPolicy as DriverShiftState["effectivePolicy"] };
  const request = buildCloudPrecheckRequest({ ...workflow, effectivePolicy: optionalPolicy }, optionalShift, vehicleId,
    { type: "SKIP_PRECHECK", reason: "OPTIONAL_CONTROL_SKIPPED" }, []);
  expect(request.inspection).toEqual({ decision: "SKIPPED", reason: "OPTIONAL_CONTROL_SKIPPED" });
  expect(request.odometer).toEqual({ decision: "SKIPPED", reason: "OPTIONAL_CONTROL_SKIPPED" });
  const disabledPolicy = { ...policy, preInspection: { ...policy.preInspection, mode: "DISABLED" as const }, startOdometer: { ...policy.startOdometer, mode: "DISABLED" as const } };
  const disabled = buildCloudPrecheckRequest({ ...workflow, effectivePolicy: disabledPolicy }, { ...shift, effectivePolicy: disabledPolicy as DriverShiftState["effectivePolicy"] },
    vehicleId, { type: "CONFIRM_VEHICLE" }, []);
  expect(disabled.inspection).toBeUndefined(); expect(disabled.odometer).toBeUndefined();
  const skipped = adoptCloudPrecheck(workflow, { shiftReference: shiftId, vehicleId, resourceVersion: 2, vehicleState: "READY",
    inspectionOutcome: "SKIPPED", odometerOutcome: "SKIPPED", odometer: null, fuelLevel: null });
  expect(skipped.preCheckComplete).toBe(false); expect(skipped.preInspectionOutcome).toBe("SKIPPED");
});

test("required control skip, reported-defect skip, moving use and changed shift binding are rejected", () => {
  expect(() => buildCloudPrecheckRequest(workflow, shift, vehicleId, { type: "SKIP_PRECHECK", reason: "OPTIONAL_CONTROL_SKIPPED" }, [])).toThrow("REQUIRED_CONTROL_CANNOT_BE_SKIPPED");
  expect(() => buildCloudPrecheckRequest({ ...workflow, moving: true }, shift, vehicleId, { type: "CONFIRM_VEHICLE" }, [])).toThrow("PARK_VEHICLE");
  expect(() => buildCloudPrecheckRequest(workflow, { ...shift, shiftGeneration: "other" }, vehicleId, { type: "CONFIRM_VEHICLE" }, [])).toThrow("SHIFT_POLICY_BINDING_CHANGED");
  const optional = { ...policy, preInspection: { ...policy.preInspection, mode: "OPTIONAL" as const }, startOdometer: { ...policy.startOdometer, mode: "OPTIONAL" as const } };
  expect(() => buildCloudPrecheckRequest({ ...workflow, effectivePolicy: optional, preCheck: { Horn: { response: "DEFECT_FOUND", severity: "CRITICAL_OUT_OF_SERVICE", note: "Synthetic fault", photoException: "CAMERA_UNAVAILABLE" } } },
    { ...shift, effectivePolicy: optional as DriverShiftState["effectivePolicy"] }, vehicleId, { type: "SKIP_PRECHECK", reason: "OPTIONAL_CONTROL_SKIPPED" }, [])).toThrow("REPORTED_DEFECT_MUST_BE_SUBMITTED");
});
