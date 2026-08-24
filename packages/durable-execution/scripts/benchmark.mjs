import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { retryDelayMilliseconds, safeTelemetry, validateEventEnvelope, validateThinJobPayload } from "../dist/index.js";

const tenantId = "11111111-1111-4111-8111-111111111111";
const uuid = "11111111-1111-4111-8111-111111111112";
function measure(name, iterations, operation) {
  const started = performance.now();
  for (let index = 0; index < iterations; index += 1) operation(index);
  const elapsedMs = performance.now() - started;
  return { name, iterations, elapsedMs: Number(elapsedMs.toFixed(3)), operationsPerSecond: Math.round(iterations / (elapsedMs / 1000)) };
}
const envelope = { eventId: uuid, aggregateType: "TRIP_REQUEST", aggregateId: uuid, aggregateVersion: 1,
  eventType: "TripCreated", schemaVersion: "v1", occurredAt: "2026-08-24T12:00:00.000Z", commandId: uuid,
  idempotencyReferenceHash: "a".repeat(64), correlationId: uuid, source: "kavaroutes.api",
  classificationReference: "REGULATED_HEALTH", purposeReference: "RIDER_INTAKE", policyReference: "privacy-synthetic-v1",
  payload: { tripId: uuid, lifecycle: "DRAFT", version: 1 } };
const thin = { tenantId, deliveryId: uuid, eventId: uuid, route: "realtime-signal", jobType: "kr.realtime-signal.trip.v1",
  eventType: "TripCreated", schemaVersion: "v1", aggregateType: "TRIP_REQUEST", aggregateId: uuid, aggregateVersion: 1,
  correlationId: uuid, classificationReference: "REGULATED_HEALTH", purposeReference: "RIDER_INTAKE", policyReference: "privacy-synthetic-v1" };
const profiles = [
  measure("dispatcher-state-changes", 10_000, () => validateEventEnvelope(envelope)),
  measure("location-burst-thin-jobs", 25_000, () => validateThinJobPayload(thin)),
  measure("nightly-optimization-backoff", 25_000, (index) => retryDelayMilliseconds("DATABASE_CONCURRENCY", index % 10, () => 0.5)),
  measure("provider-outage-telemetry", 25_000, () => safeTelemetry({ name: "effect.outcome", route: "integration", jobType: "kr.integration.partner.v1", status: "RETRY", failureClass: "TRANSIENT_DEPENDENCY", handlerVersion: "v1", environment: "TEST", durationMs: 12 })),
];
assert.ok(profiles.every((profile) => profile.operationsPerSecond > 1_000));
const artifact = { format: 1, environment: "local-synthetic", profiles };
await writeFile(resolve(import.meta.dirname, "../artifacts/benchmark-results.json"), `${JSON.stringify(artifact, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(artifact, null, 2)}\n`);
