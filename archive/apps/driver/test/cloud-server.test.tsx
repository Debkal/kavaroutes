import { createCloudDriverApi, decodeCloudPrecheckReceipt } from "../src/cloud-server";
import type { DevelopmentFetch } from "@kavaroutes/api-contracts/private-development-transport";

const organizationId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const driverId = "30000000-0000-4000-8000-000000000001";
const assignmentId = "40000000-0000-4000-8000-000000000001";
const control = { mode: "REQUIRED", source: "TIER_DEFAULT", reasonCode: "ENTERPRISE_STRICT_DEFAULT", locked: true };
const policy = { schemaVersion: 1, organizationId, driverId, assignmentId, commercialTier: "ENTERPRISE", workforceRelationship: "EMPLOYEE", policyVersion: 1,
  resolvedAt: "2026-09-13T16:00:00.000Z", preInspection: control, postInspection: control, startOdometer: control, endOdometer: control,
  returnVerification: { ...control, mode: "REQUIRED_WITH_AUDITED_OVERRIDE" }, routeChange: { ...control, mode: "DISPATCH_APPROVAL_REQUIRED" },
  proofOfServicePolicy: "PAYER_CONTRACT_ORGANIZATION_RESOLVED", nonWaivableControls: ["IDENTITY_AND_AUTHORIZATION", "TENANT_ISOLATION", "ENCRYPTION_AND_AUDIT", "MINIMUM_NECESSARY", "NO_PHI_NAVIGATION", "TRACKING_TRANSPARENCY", "EMERGENCY_STOP"], canonicalDigest: "a".repeat(64) };
const leg = {
  assignmentId, assignmentVersion: 1, runId: "40000000-0000-4000-8000-000000000002", runVersion: 1,
  runLifecycle: "scheduled", vehicleId: null, vehicleLabel: null,
  tripId: "40000000-0000-4000-8000-000000000003", tripLegId: "40000000-0000-4000-8000-000000000004", ordinal: 1,
  riderLabel: "Synthetic Rider", pickupLabel: "Synthetic pickup", dropoffLabel: "Synthetic dropoff",
  plannedStartAt: "2026-09-13T16:00:00.000Z", plannedEndAt: "2026-09-13T17:00:00.000Z", serviceTimezone: "America/Los_Angeles",
};
const response = (body: unknown, status = 200) => ({ status, headers: { get: () => null }, json: async () => body });

test("Driver cloud adapter authenticates, reads itinerary, and starts with server identity", async () => {
  const calls: { url: string; init: Parameters<DevelopmentFetch>[1] }[] = [];
  const fetcher: DevelopmentFetch = async (url, init) => {
    calls.push({ url, init });
    if (url.endsWith("/v1/me")) return response({ principalKind: "SYNTHETIC_DEVICE", organizations: [{ organizationId, capabilities: ["driver:manifest:read", "driver:execute"] }] });
    if (url.includes("/driver/itineraries/")) return response({ driverReference: driverId, serviceDate: "2026-09-13", legs: [leg] });
    return response({ outcome: "APPLIED", shiftReference: "50000000-0000-4000-8000-000000000001",
      shiftGeneration: "50000000-0000-4000-8000-000000000002", resourceVersion: 1, effectivePolicy: policy });
  };
  const api = createCloudDriverApi({ baseUrl: "http://127.0.0.1:58080", fetch: fetcher });
  await expect(api.authenticate()).resolves.toMatchObject({ value: "authenticated" });
  await expect(api.getItinerary("2026-09-13")).resolves.toMatchObject({ value: { legs: [leg] } });
  await expect(api.startShift({ assignmentId, assignmentVersion: 1, serviceDate: "2026-09-13", idempotencyKey: "driver-shift-test-key-0001" })).resolves.toMatchObject({ value: { outcome: "APPLIED" } });
  expect(calls[2]!.init.headers.authorization).toBe("Synthetic principal_driver");
  expect(calls[2]!.init.headers["idempotency-key"]).toBe("driver-shift-test-key-0001");
  expect(JSON.parse(calls[2]!.init.body!)).toEqual({ assignmentId, expectedAssignmentVersion: 1, serviceDate: "2026-09-13" });
});

test("Driver cloud adapter rejects cross-subject and malformed responses", async () => {
  const api = createCloudDriverApi({ baseUrl: "http://127.0.0.1:58080", fetch: async () => response({ driverReference: "other-driver", serviceDate: "2026-09-13", legs: [] }) });
  await expect(api.getItinerary("2026-09-13")).rejects.toMatchObject({ code: "INVALID_API_RESPONSE" });
  const badShift = createCloudDriverApi({ baseUrl: "http://127.0.0.1:58080", fetch: async () => response({ outcome: "APPLIED", shiftReference: "50000000-0000-4000-8000-000000000001",
    shiftGeneration: "50000000-0000-4000-8000-000000000002", resourceVersion: 1, effectivePolicy: { ...policy, assignmentId: "other-assignment" } }) });
  await expect(badShift.startShift({ assignmentId, assignmentVersion: 1, serviceDate: "2026-09-13", idempotencyKey: "driver-shift-test-key-0002" })).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN" });
});

test("Driver submits a real vehicle decision with stable key and rejects cross-shift or contradictory receipts", async () => {
  const shiftReference = "50000000-0000-4000-8000-000000000001";
  const vehicleId = "50000000-0000-4000-8000-000000000003";
  const receipt = { shiftReference, vehicleId, resourceVersion: 2, vehicleState: "READY", inspectionOutcome: "SKIPPED",
    odometerOutcome: "SKIPPED", odometer: null, fuelLevel: null };
  const calls: { url: string; body: string | undefined; key: string | undefined }[] = [];
  const api = createCloudDriverApi({ baseUrl: "http://127.0.0.1:58080", fetch: async (url, init) => {
    calls.push({ url, body: init.body, key: init.headers["idempotency-key"] }); return response(receipt);
  } });
  const request = { shiftGeneration: "50000000-0000-4000-8000-000000000002", vehicleId, policyDigest: "a".repeat(64), expectedVersion: 1,
    capturedAt: "2026-09-14T16:00:00Z", photos: [] };
  await expect(api.submitPrecheck(shiftReference, request, "precheck-test-stable-key-0001")).resolves.toMatchObject({ value: receipt });
  expect(calls[0]!.url).toContain(`/shifts/${shiftReference}/commands/precheck`);
  expect(JSON.parse(calls[0]!.body!)).toEqual(request); expect(calls[0]!.key).toBe("precheck-test-stable-key-0001");
  expect(() => decodeCloudPrecheckReceipt({ ...receipt, shiftReference: "another-shift" }, shiftReference)).toThrow();
  expect(() => decodeCloudPrecheckReceipt({ ...receipt, odometer: 100 }, shiftReference)).toThrow();
});

test("Driver cloud adapter accepts persisted execution and rejects malformed versions", async () => {
  const execution = { executionId: "50000000-0000-4000-8000-000000000003", lifecycle: "EN_ROUTE_PICKUP", version: 2 };
  const create = (value: unknown) => createCloudDriverApi({ baseUrl: "http://127.0.0.1:58080", fetch: async () =>
    response({ driverReference: driverId, serviceDate: "2026-09-13", legs: [{ ...leg, execution: value }] }) });
  await expect(create(execution).getItinerary("2026-09-13")).resolves.toMatchObject({ value: { legs: [{ execution }] } });
  await expect(create(null).getItinerary("2026-09-13")).resolves.toMatchObject({ value: { legs: [{ execution: null }] } });
  await expect(create({ ...execution, version: 0 }).getItinerary("2026-09-13")).rejects.toMatchObject({ code: "INVALID_API_RESPONSE" });
});
