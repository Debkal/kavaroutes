import assert from "node:assert/strict";
import test from "node:test";
import { createWp007Api, strongEtag, syntheticIds, syntheticReadModels } from "../dist/index.js";

const auth = (principal) => ({ authorization: `Synthetic ${principal}` });
const tripId = "11111111-1111-4111-8111-111111111111";
const riderId = "11111111-1111-4111-8111-111111111112";
const trip = { tripId, riderReference: riderId, serviceDate: "2026-08-24", serviceTimezone: "America/Los_Angeles",
  resolvedServiceAt: "2026-08-24T15:00:00.000Z", lifecycle: "DRAFT", version: 1, databaseOnlySecret: "must-be-stripped" };

function memoryApplication() {
  const current = { ...trip };
  return {
    etag: (resourceId, version, projection) => strongEtag("synthetic-etag-secret-memory-tests-1234", resourceId, version, projection),
    async createTrip() { return { replayed: false, statusCode: 201, body: current, headers: { location: `/v1/organizations/${syntheticIds.organizationA}/trips/${tripId}`, etag: this.etag(tripId, 1, "dispatcher-trip-v1") } }; },
    async readTrip(_organizationId, requestedTripId) { return requestedTripId === tripId ? current : null; },
    async listTrips(_organizationId, { afterId, limit }) {
      const values = [current, { ...current, tripId: "22222222-2222-4222-8222-222222222222" }, { ...current, tripId: "33333333-3333-4333-8333-333333333333" }];
      return values.filter((value) => !afterId || value.tripId > afterId).slice(0, limit + 1);
    },
    async searchRiders() { return [{ riderId, syntheticDisplayLabel: "Synthetic Rider 1" }]; },
    async cancelTrip() { const changed = { ...current, lifecycle: "CANCELLED", version: 2 }; return { replayed: false, statusCode: 200,
      body: { trip: changed, receipt: { command: "CancelTrip", outcome: "APPLIED", resourceVersion: 2 } }, headers: { etag: this.etag(tripId, 2, "dispatcher-trip-v1") } }; },
    async readDispatchDay() { return []; },
  };
}

test("authentication, enumeration-safe authorization, media negotiation, and safe telemetry fail closed", async (t) => {
  const telemetry = [];
  const app = await createWp007Api({ application: memoryApplication(), telemetrySink: (event) => telemetry.push(event) });
  t.after(() => app.close());
  let response = await app.inject({ method: "GET", url: "/v1/me" });
  assert.equal(response.statusCode, 401);
  assert.match(response.headers["www-authenticate"], /^Synthetic/);
  assert.equal(response.headers["cache-control"], "no-store");
  response = await app.inject({ method: "GET", url: "/v1/me", headers: { ...auth("principal_dispatcher"), accept: "text/html" } });
  assert.equal(response.statusCode, 406);
  response = await app.inject({ method: "GET", url: `/v1/organizations/${syntheticIds.organizationA}/trips`, headers: auth("principal_outsider") });
  assert.equal(response.statusCode, 404);
  response = await app.inject({ method: "GET", url: `/v1/organizations/${syntheticIds.organizationA}/trips?token=secret`, headers: auth("principal_dispatcher") });
  assert.equal(response.statusCode, 400);
  assert.ok(telemetry.every((event) => !JSON.stringify(event).includes("token=secret") && !JSON.stringify(event).includes(tripId)));
});

test("resource, collection, conditional, search, command, and response-projection contracts work", async (t) => {
  const app = await createWp007Api({ application: memoryApplication(), now: () => new Date("2026-08-24T12:00:00.000Z") });
  t.after(() => app.close());
  const dispatcher = auth("principal_dispatcher");
  const detailUrl = `/v1/organizations/${syntheticIds.organizationA}/trips/${tripId}`;
  let response = await app.inject({ method: "GET", url: detailUrl, headers: dispatcher });
  assert.equal(response.statusCode, 200);
  assert.equal("databaseOnlySecret" in response.json(), false);
  const etag = response.headers.etag;
  response = await app.inject({ method: "HEAD", url: detailUrl, headers: dispatcher });
  assert.equal(response.statusCode, 200);
  assert.equal(response.body, "");
  response = await app.inject({ method: "GET", url: detailUrl, headers: { ...dispatcher, "if-none-match": etag } });
  assert.equal(response.statusCode, 304);
  response = await app.inject({ method: "GET", url: `/v1/organizations/${syntheticIds.organizationA}/trips?limit=1`, headers: dispatcher });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().items.length, 1);
  assert.match(response.headers.link, /cursor=/);
  response = await app.inject({ method: "POST", url: `/v1/organizations/${syntheticIds.organizationA}/rider-searches`, headers: dispatcher,
    payload: { syntheticReferencePrefix: "synthetic-rider" } });
  assert.equal(response.statusCode, 200);
  response = await app.inject({ method: "POST", url: `${detailUrl}/commands/cancel`, headers: { ...dispatcher, "idempotency-key": "cancel-trip-key-0001" },
    payload: { reasonCode: "SYNTHETIC_REQUESTER_CANCELLED" } });
  assert.equal(response.statusCode, 428);
  response = await app.inject({ method: "POST", url: `${detailUrl}/commands/cancel`, headers: { ...dispatcher, "idempotency-key": "cancel-trip-key-0001", "if-match": etag },
    payload: { reasonCode: "SYNTHETIC_REQUESTER_CANCELLED" } });
  assert.equal(response.statusCode, 200);
});

test("strict bodies, driver batch limits/order/replay, operation access, and rate limits are enforced", async (t) => {
  const app = await createWp007Api({ application: memoryApplication(), rateLimitPerOperation: 1 });
  t.after(() => app.close());
  const driver = auth("principal_driver");
  const base = `/v1/organizations/${syntheticIds.organizationA}`;
  let response = await app.inject({ method: "POST", url: `${base}/rider-searches`, headers: { ...auth("principal_dispatcher"), "content-type": "application/json" },
    payload: '{"syntheticReferencePrefix":"synthetic-rider","syntheticReferencePrefix":"synthetic-other"}' });
  assert.equal(response.statusCode, 400);
  response = await app.inject({ method: "POST", url: `${base}/rider-searches`, headers: { ...auth("principal_dispatcher"), "content-type": "text/plain" }, payload: "synthetic-rider" });
  assert.equal(response.statusCode, 415);
  response = await app.inject({ method: "POST", url: `${base}/rider-searches`, headers: { ...auth("principal_dispatcher"), "content-type": "application/json" },
    payload: JSON.stringify({ syntheticReferencePrefix: "synthetic-rider", padding: "x".repeat(256 * 1024) }) });
  assert.equal(response.statusCode, 413);
  response = await app.inject({ method: "GET", url: `${base}/driver/manifest`, headers: auth("principal_dispatcher") });
  assert.equal(response.statusCode, 404);
  response = await app.inject({ method: "GET", url: `${base}/driver/manifest`, headers: driver });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(Object.keys(response.json()).sort(), ["assignments", "driverReference", "effectivePolicy", "effectivePolicyDigest", "serviceDate", "serviceTimezone", "version"]);
  assert.equal(response.json().effectivePolicy.commercialTier, "ENTERPRISE");
  assert.equal(response.json().effectivePolicy.workforceRelationship, "EMPLOYEE");
  assert.equal(response.json().effectivePolicyDigest, response.json().effectivePolicy.canonicalDigest);
  const action = (id, sequence) => ({ clientActionId: id, deviceEpoch: 1, sequence, capturedAt: "2026-08-24T12:00:00.000Z", command: "MARK_EN_ROUTE",
    resourceReference: tripId, expectedTag: strongEtag("secret", tripId, 1, "driver"), idempotencyKey: `action-item-key-${String(sequence).padStart(4, "0")}` });
  const batch = { deviceSessionId: "44444444-4444-4444-8444-444444444444", items: [action("55555555-5555-4555-8555-555555555555", 2), action("66666666-6666-4666-8666-666666666666", 1)] };
  response = await app.inject({ method: "POST", url: `${base}/driver/action-batches`, headers: { ...driver, "idempotency-key": "action-batch-key-0001" }, payload: batch });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json().items.map((item) => item.outcome), ["APPLIED", "REJECTED"]);
  response = await app.inject({ method: "POST", url: `${base}/driver/action-batches`, headers: { ...driver, "idempotency-key": "action-batch-key-0001" }, payload: batch });
  assert.equal(response.statusCode, 429);
  assert.equal(response.headers["retry-after"], "1");

  response = await app.inject({ method: "GET", url: `${base}/operations/${syntheticReadModels.operation.operationId}`, headers: auth("principal_integration") });
  assert.equal(response.statusCode, 200);
});

test("Driver control policy is versioned, capability-separated, and not writable by the Driver", async (t) => {
  const app = await createWp007Api({ application: memoryApplication(), now: () => new Date("2026-08-27T12:00:00.000Z") });
  t.after(() => app.close()); const base = `/v1/organizations/${syntheticIds.organizationA}/driver-control-policy`;
  let response = await app.inject({ method: "GET", url: base, headers: auth("principal_driver") }); assert.equal(response.statusCode, 403);
  response = await app.inject({ method: "GET", url: base, headers: auth("principal_dispatcher") }); assert.equal(response.statusCode, 200);
  assert.equal(response.json().commercialTier, "ENTERPRISE"); const etag = response.headers.etag;
  const controls = { preInspection: { mode: "OPTIONAL", locked: false }, postInspection: { mode: "OPTIONAL", locked: false },
    startOdometer: { mode: "OPTIONAL", locked: false }, endOdometer: { mode: "OPTIONAL", locked: false },
    returnVerification: { mode: "ADVISORY", locked: false }, routeChange: { mode: "AUTHORIZED_SELF_APPROVE", locked: false } };
  response = await app.inject({ method: "POST", url: `${base}/commands/update`, headers: { ...auth("principal_dispatcher"), "idempotency-key": "policy-update-key-0001", "if-match": etag }, payload: { reasonCode: "OPERATING_POLICY_CHANGED", controls } });
  assert.equal(response.statusCode, 403); assert.equal(response.json().code, "POLICY_OVERRIDE_CAPABILITY_REQUIRED");
  response = await app.inject({ method: "POST", url: `${base}/commands/update`, headers: { ...auth("principal_policy_override"), "idempotency-key": "policy-update-key-0002", "if-match": etag },
    payload: { reasonCode: "OPERATING_POLICY_CHANGED", controls, secondApprovalReference: syntheticIds.dispatcher } });
  assert.equal(response.statusCode, 200); assert.equal(response.json().version, 2); assert.notEqual(response.headers.etag, etag);
  const firstBody = response.json();
  response = await app.inject({ method: "POST", url: `${base}/commands/update`, headers: { ...auth("principal_policy_override"), "idempotency-key": "policy-update-key-0002", "if-match": etag },
    payload: { reasonCode: "OPERATING_POLICY_CHANGED", controls, secondApprovalReference: syntheticIds.dispatcher } });
  assert.equal(response.statusCode, 200); assert.equal(response.headers["kavaroutes-idempotency-replayed"], "true"); assert.deepEqual(response.json(), firstBody);
  response = await app.inject({ method: "POST", url: `${base}/commands/update`, headers: { ...auth("principal_policy_override"), "idempotency-key": "policy-update-key-0003", "if-match": etag },
    payload: { reasonCode: "OPERATING_POLICY_CHANGED", controls, secondApprovalReference: syntheticIds.dispatcher } });
  assert.equal(response.statusCode, 412);
});

test("Driver policy action commands are structurally closed and digest-bound", async (t) => {
  const app = await createWp007Api({ application: memoryApplication() });
  t.after(() => app.close());
  const url = `/v1/organizations/${syntheticIds.organizationA}/driver/action-batches`;
  const manifest = await app.inject({ method: "GET", url: `/v1/organizations/${syntheticIds.organizationA}/driver/manifest`, headers: auth("principal_driver") });
  const policyDigest = manifest.json().effectivePolicyDigest;
  const action = { clientActionId: "55555555-5555-4555-8555-555555555556", deviceEpoch: 1, sequence: 1,
    capturedAt: "2026-08-27T12:00:00.000Z", command: "SKIP_PRECHECK", resourceReference: tripId,
    expectedTag: strongEtag("secret", tripId, 1, "driver"), idempotencyKey: "policy-action-item-0001" };
  let response = await app.inject({ method: "POST", url, headers: { ...auth("principal_driver"), "idempotency-key": "policy-action-batch-0001" },
    payload: { deviceSessionId: "44444444-4444-4444-8444-444444444444", items: [action] } });
  assert.equal(response.statusCode, 400);
  response = await app.inject({ method: "POST", url, headers: { ...auth("principal_driver"), "idempotency-key": "policy-action-batch-0002" },
    payload: { deviceSessionId: "44444444-4444-4444-8444-444444444444", items: [{ ...action, reasonCode: "OPTIONAL_CONTROL_SKIPPED", policyDigest: "a".repeat(64) }] } });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().items[0].code, "STALE_POLICY_SNAPSHOT");
  response = await app.inject({ method: "POST", url, headers: { ...auth("principal_driver"), "idempotency-key": "policy-action-batch-0003" },
    payload: { deviceSessionId: "44444444-4444-4444-8444-444444444444", items: [{ ...action, clientActionId: "55555555-5555-4555-8555-555555555557", sequence: 2, reasonCode: "OPTIONAL_CONTROL_SKIPPED", policyDigest }] } });
  assert.equal(response.statusCode, 200); assert.equal(response.json().items[0].code, "CONTROL_REQUIRED_CANNOT_SKIP");
  response = await app.inject({ method: "POST", url, headers: { ...auth("principal_driver"), "idempotency-key": "policy-action-batch-0004" },
    payload: { deviceSessionId: "44444444-4444-4444-8444-444444444444", items: [{ ...action, clientActionId: "55555555-5555-4555-8555-555555555558", sequence: 3, command: "COMPLETE_PRECHECK", policyDigest }] } });
  assert.equal(response.statusCode, 200); assert.equal(response.json().items[0].outcome, "APPLIED");
});

test("offline idempotent replay and payload mismatch are exact with normal rate capacity", async (t) => {
  const app = await createWp007Api({ application: memoryApplication() });
  t.after(() => app.close());
  const driver = auth("principal_driver");
  const url = `/v1/organizations/${syntheticIds.organizationA}/driver/location-batches`;
  const sample = { sampleId: "77777777-7777-4777-8777-777777777777", deviceEpoch: 1, sequence: 1, capturedAt: "2026-08-24T12:00:00.000Z", longitude: -118.2, latitude: 34.1 };
  const batch = { deviceId: "88888888-8888-4888-8888-888888888888", samples: [sample] };
  const headers = { ...driver, "idempotency-key": "location-batch-0001" };
  const first = await app.inject({ method: "POST", url, headers, payload: batch });
  const replay = await app.inject({ method: "POST", url, headers, payload: batch });
  assert.equal(first.statusCode, 200);
  assert.equal(replay.statusCode, 200);
  assert.equal(replay.headers["kavaroutes-idempotency-replayed"], "true");
  assert.deepEqual(replay.json(), first.json());
  const mismatch = await app.inject({ method: "POST", url, headers, payload: { ...batch, samples: [{ ...sample, latitude: 35 }] } });
  assert.equal(mismatch.statusCode, 422);
  const tooMany = await app.inject({ method: "POST", url, headers: { ...driver, "idempotency-key": "location-batch-0002" }, payload: { ...batch, samples: Array.from({ length: 501 }, (_, index) => ({ ...sample, sampleId: `${String(index).padStart(8, "0")}-7777-4777-8777-777777777777`, sequence: index + 1 })) } });
  assert.equal(tooMany.statusCode, 400);
});
