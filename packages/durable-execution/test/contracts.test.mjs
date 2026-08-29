import assert from "node:assert/strict";
import test from "node:test";
import { FAILURE_POLICIES, OUTBOX_ROUTES, ROUTE_POLICIES, coalesceLocationBatchSignals, createPublisherCoordinator, retryDelayMilliseconds, safeTelemetry, validateEventEnvelope, validateThinJobPayload } from "../dist/index.js";

const uuid = "11111111-1111-4111-8111-111111111111";
const envelope = { eventId: uuid, aggregateType: "TRIP_REQUEST", aggregateId: uuid, aggregateVersion: 1,
  eventType: "TripCreated", schemaVersion: "v1", occurredAt: "2026-08-24T12:00:00.000Z", commandId: uuid,
  idempotencyReferenceHash: "a".repeat(64), correlationId: uuid, source: "kavaroutes.api",
  classificationReference: "REGULATED_HEALTH", purposeReference: "RIDER_INTAKE", policyReference: "privacy-synthetic-v1",
  payload: { tripId: uuid, lifecycle: "DRAFT", version: 1 } };

test("closed envelope and thin-job schemas reject unknown, unsupported, and sensitive fields", () => {
  assert.deepEqual(validateEventEnvelope(envelope), envelope);
  assert.throws(() => validateEventEnvelope({ ...envelope, unexpected: true }), /UNSUPPORTED_SCHEMA/);
  assert.throws(() => validateEventEnvelope({ ...envelope, schemaVersion: "v2" }), /UNSUPPORTED_SCHEMA/);
  assert.throws(() => validateEventEnvelope({ ...envelope, payload: { ...envelope.payload, phone: "synthetic" } }), /PAYLOAD_POLICY_VIOLATION/);
  const notification = { ...envelope, eventType: "NotificationIntentCreated", aggregateType: "NOTIFICATION_INTENT",
    payload: { v: "1", kind: "sync_available", action: "open_and_sync" } };
  assert.deepEqual(validateEventEnvelope(notification), notification);
  assert.throws(() => validateEventEnvelope({ ...notification, payload: { ...notification.payload, tripId: uuid } }), /UNSUPPORTED_SCHEMA/);
  const thin = { tenantId: uuid, deliveryId: uuid, eventId: uuid, route: "projection", jobType: "kr.projection.trip.v1",
    eventType: "TripCreated", schemaVersion: "v1", aggregateType: "TRIP_REQUEST", aggregateId: uuid, aggregateVersion: 1,
    correlationId: uuid, classificationReference: "REGULATED_HEALTH", purposeReference: "RIDER_INTAKE", policyReference: "privacy-synthetic-v1" };
  assert.deepEqual(validateThinJobPayload(thin), thin);
  assert.throws(() => validateThinJobPayload({ ...thin, payload: envelope.payload }), /UNSUPPORTED_SCHEMA/);
});

test("all eight routes and all failure classes have explicit bounded policy", () => {
  assert.equal(OUTBOX_ROUTES.length, 8);
  assert.deepEqual(Object.keys(ROUTE_POLICIES).sort(), [...OUTBOX_ROUTES].sort());
  assert.equal(Object.keys(FAILURE_POLICIES).length, 7);
  assert.equal(retryDelayMilliseconds("PERMANENT_VALIDATION", 0), null);
  assert.equal(retryDelayMilliseconds("TRANSIENT_DEPENDENCY", 8), null);
  assert.equal(retryDelayMilliseconds("TRANSIENT_DEPENDENCY", 1, () => 0.5), 1000);
});

test("telemetry exposes only bounded operational labels", () => {
  assert.deepEqual(safeTelemetry({ name: "outbox.publish", route: "projection", jobType: "kr.projection.trip.v1", status: "SUCCESS", handlerVersion: "v1", environment: "LOCAL", durationMs: 3.9 }),
    { name: "outbox.publish", route: "projection", job_type: "kr.projection.trip.v1", status: "SUCCESS", handler_version: "v1", environment: "LOCAL", duration_ms: 3 });
  assert.throws(() => safeTelemetry({ name: "outbox.publish", route: "projection", jobType: `kr.projection.${uuid}.v1`, status: "SUCCESS", handlerVersion: "v1", environment: "LOCAL", durationMs: 1 }), /UNSAFE_TELEMETRY/);
});

test("coalescing, round-robin fairness, connection admission, and graceful drain are bounded", async () => {
  const referenceA = "11111111-1111-4111-8111-111111111111";
  const referenceB = "22222222-2222-4222-8222-222222222222";
  const windowStartedAt = "2026-08-24T12:00:00.000Z";
  assert.equal(coalesceLocationBatchSignals(Array.from({ length: 500 }, () => ({ driverReference: referenceA, aggregateReference: referenceB, windowStartedAt }))).length, 1);
  const calls = [];
  const source = { claimEligible: async (input) => { calls.push(input.tenantId); return [{ tenantId: input.tenantId, deliveryId: referenceA, messageId: referenceB,
    route: input.route, jobType: "kr.projection.trip.v1", leaseVersion: 1, publishAttempts: 1, leaseExpiresAt: windowStartedAt }]; } };
  const coordinator = createPublisherCoordinator(source, { tenantIds: [referenceA, referenceB], routes: ["projection"], batchSize: 2, leaseMilliseconds: 30_000, maxBackgroundConnections: 1 });
  assert.deepEqual((await coordinator.runCycle("publisher.test", async () => Promise.resolve())).tenantOrder, [referenceA, referenceB]);
  assert.deepEqual((await coordinator.runCycle("publisher.test", async () => Promise.resolve())).tenantOrder, [referenceB, referenceA]);
  assert.deepEqual(calls, [referenceA, referenceB, referenceB, referenceA]);
  await coordinator.shutdown();
  assert.equal(coordinator.state, "STOPPED");
  assert.equal((await coordinator.runCycle("publisher.test", async () => Promise.resolve())).claimed, 0);
});
