import assert from "node:assert/strict";
import test from "node:test";
import { Value } from "typebox/value";
import { createMemoryClientProjection } from "@kavaroutes/realtime";
import { buildAppleMapsUrl, buildGoogleDirectionsUrl, canonicalActionFingerprintInput, classifyActionResponse, createDeterministicEncryptedStoreFake, createDriverRecoveryClient, createDriverSync, createLocationBatches,
  DEFAULT_SAMPLING_POLICY, driverSchemas, DRIVER_MIGRATIONS, normalizeLocation, resolveTrackingState, safeDriverTelemetry,
  handoffNavigation, toWp007ActionBatch, toWp007LocationBatch, updateVehicleMotion } from "../dist/index.js";

const action = Object.freeze({ actionId: "33333333-3333-4333-8333-333333333331", idempotencyKey: "idem_synthetic_0000000001",
  fingerprint: "a".repeat(64), resourceReference: "33333333-3333-4333-8333-333333333332", expectedVersion: 1,
  expectedTag: `"kr1.${"a".repeat(32)}"`, causalSequence: 1, deviceEpoch: 1, sequence: 1, capturedAt: "2026-08-25T12:00:00.000Z", command: "ARRIVE_PICKUP", state: "PENDING", attempt: 0,
  nextAttemptAt: "2026-08-25T12:00:00.000Z" });

test("closed contracts, routes, policies, and parameterized migrations are bounded", () => {
  assert.equal(driverSchemas.length, 7);
  for (const schema of driverSchemas) if (schema.type === "object") assert.equal(schema.additionalProperties, false);
  assert.ok(Value.Check(driverSchemas.find((schema) => schema.$id === "DriverAction"), action));
  assert.equal(DRIVER_MIGRATIONS.length, 3);
  const sql = DRIVER_MIGRATIONS[0].sql;
  for (const table of ["local_session", "manifest_snapshot", "manifest_stop", "sync_cursor", "client_action", "location_epoch", "location_sample", "location_batch", "evidence_draft", "evidence_blob", "sync_attempt", "safe_diagnostic"]) assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`));
  assert.doesNotMatch(sql, /rider_name|patient|medical|address_line|latitude|longitude|access_token/i);
  assert.match(DRIVER_MIGRATIONS[1].sql, /CREATE TABLE IF NOT EXISTS workflow_checkpoint/);
  assert.match(DRIVER_MIGRATIONS[2].sql, /ADD COLUMN policy_digest/);
  assert.equal(canonicalActionFingerprintInput(action), '{"resourceReference":"33333333-3333-4333-8333-333333333332","expectedVersion":1,"causalSequence":1,"command":"ARRIVE_PICKUP"}');
});

test("encrypted-store fake proves binding, atomic cursor apply, rollback, key loss, and wipe", async () => {
  const store = createDeterministicEncryptedStoreFake();
  assert.equal(await store.initialize({ installationGeneration: "inst_0000000000000001", keyMaterial: "key_synthetic_0000000000000001" }), "CREATED");
  await store.transaction(async (tx) => { await tx.saveProjection({ manifestReference: "ref_synthetic_manifest" }, "rtc1.synthetic-encrypted-cursor"); await tx.enqueueAction(action); });
  assert.equal(store.inspect().actions.size, 1); assert.equal(store.inspect().cursor, "rtc1.synthetic-encrypted-cursor");
  await assert.rejects(() => store.transaction(async (tx) => { await tx.updateAction(action.actionId, "UPLOADING", 1); throw new Error("SYNTHETIC_PROCESS_DEATH"); }), /SYNTHETIC_PROCESS_DEATH/);
  assert.equal(store.inspect().actions.get(action.actionId).state, "PENDING");
  assert.equal(await store.initialize({ installationGeneration: "inst_0000000000000002", keyMaterial: "key_synthetic_0000000000000002" }), "QUARANTINED");
  assert.equal(await store.integrityCheck(), false); await store.wipe(); assert.equal(store.inspect().actions.size, 0);
});

test("action upload keeps stable identity and surfaces accepted, conflict, unknown, and reauthentication", async () => {
  for (const fixture of [{ outcome: "ACCEPTED", status: 200, final: "LIVE" }, { outcome: "CONFLICT", status: 412, final: "CONFLICT" },
    { outcome: "UNKNOWN", status: 504, final: "OFFLINE_QUEUE_PENDING" }, { outcome: "PERMANENT_REJECTION", status: 403, final: "REAUTH_REQUIRED" }]) {
    const store = createDeterministicEncryptedStoreFake(); await store.initialize({ installationGeneration: "inst_0000000000000001", keyMaterial: "key_synthetic_0000000000000001" });
    const transport = { async uploadAction() { return fixture; }, async uploadLocations(samples) { return samples.map((sample) => ({ sampleId: sample.sampleId, outcome: "APPLIED" })); }, async uploadEvidence() { return { outcome: "UNKNOWN" }; } };
    const sync = createDriverSync(store, transport); await sync.enqueue(action); await sync.uploadAction(action); assert.equal(sync.state(), fixture.final);
    assert.equal(store.inspect().actions.get(action.actionId).attempt, 1); assert.equal(store.inspect().actions.get(action.actionId).state, classifyActionResponse(fixture.status).actionState);
  }
  assert.deepEqual([401, 403, 409, 412, 422, 429, 500, 502, 503, 504].map((status) => [status, classifyActionResponse(status)]), [
    [401, { actionState: "PERMANENT_REJECTION", syncState: "REAUTH_REQUIRED" }], [403, { actionState: "PERMANENT_REJECTION", syncState: "REAUTH_REQUIRED" }],
    [409, { actionState: "CONFLICT", syncState: "CONFLICT" }], [412, { actionState: "CONFLICT", syncState: "CONFLICT" }],
    [422, { actionState: "PERMANENT_REJECTION", syncState: "OFFLINE_QUEUE_PENDING" }], [429, { actionState: "UNKNOWN", syncState: "OFFLINE_QUEUE_PENDING" }],
    [500, { actionState: "UNKNOWN", syncState: "OFFLINE_QUEUE_PENDING" }], [502, { actionState: "UNKNOWN", syncState: "OFFLINE_QUEUE_PENDING" }],
    [503, { actionState: "UNKNOWN", syncState: "OFFLINE_QUEUE_PENDING" }], [504, { actionState: "UNKNOWN", syncState: "OFFLINE_QUEUE_PENDING" }],
  ]);
});

test("twelve-hour location queue is ordered, deduplicated, and bounded into WP007 batches", async () => {
  const samples = Array.from({ length: 2_880 }, (_, index) => normalizeLocation({ sampleId: `loc_${String(index + 1).padStart(16, "0")}`, epoch: 1, sequence: index + 1,
    capturedAt: new Date(Date.UTC(2026, 7, 25, 0, 0, index * 15)).toISOString(), latitude: 34 + ((index % 10) / 10_000), longitude: -118 - ((index % 10) / 10_000), accuracyMeters: 8 }, DEFAULT_SAMPLING_POLICY));
  const batches = createLocationBatches([...samples].reverse(), DEFAULT_SAMPLING_POLICY);
  assert.equal(batches.length, 6); assert.equal(batches.flat().length, 2_880); assert.ok(batches.every((batch) => batch.length <= 500 && Buffer.byteLength(JSON.stringify(batch)) <= 1_048_576));
  const store = createDeterministicEncryptedStoreFake(); await store.initialize({ installationGeneration: "inst_0000000000000001", keyMaterial: "key_synthetic_0000000000000001" });
  await store.transaction(async (tx) => { await tx.appendLocations(samples); await tx.appendLocations(samples.slice(0, 20)); });
  assert.equal(store.inspect().locations.size, 2_880);
  assert.equal(toWp007LocationBatch(batches[0], "33333333-3333-4333-8333-333333333333").samples.length, 500);
  assert.equal(toWp007ActionBatch(action, "33333333-3333-4333-8333-333333333334").items[0].expectedTag, action.expectedTag);
});

test("Driver recovery consumes the public WP009 native state machine", () => {
  const recovery = createDriverRecoveryClient(createMemoryClientProjection());
  assert.equal(recovery.state(), "DISCONNECTED"); recovery.transition("AUTHENTICATING"); recovery.transition("REPLAYING"); recovery.transition("LIVE");
  assert.equal(recovery.state(), "LIVE");
});

test("tracking states report permission, approximate, pause, stop, stale, and live truthfully", () => {
  const base = { configured: true, foreground: "GRANTED", background: "GRANTED", precise: true, active: true, stopped: false, systemPaused: false, revoked: false,
    lastSampleAt: new Date("2026-08-25T11:59:50.000Z"), now: new Date("2026-08-25T12:00:00.000Z"), policy: DEFAULT_SAMPLING_POLICY };
  assert.equal(resolveTrackingState(base), "TRACKING");
  assert.equal(resolveTrackingState({ ...base, precise: false }), "DEGRADED_APPROXIMATE");
  assert.equal(resolveTrackingState({ ...base, background: "DENIED" }), "PERMISSION_REQUIRED");
  assert.equal(resolveTrackingState({ ...base, systemPaused: true }), "PAUSED_BY_SYSTEM");
  assert.equal(resolveTrackingState({ ...base, stopped: true }), "STOPPED_BY_DRIVER");
  assert.equal(resolveTrackingState({ ...base, lastSampleAt: new Date("2026-08-25T11:58:00.000Z") }), "STALE");
  assert.equal(resolveTrackingState({ ...base, revoked: true }), "REVOKED");
  let motion = { moving: false, stationaryConfirmations: 0 };
  motion = updateVehicleMotion(motion, { speedMetersPerSecond: 2.1, accuracyMeters: 8 }); assert.equal(motion.moving, true);
  motion = updateVehicleMotion(motion, { speedMetersPerSecond: 0.2, accuracyMeters: 8 }); assert.equal(motion.moving, true);
  motion = updateVehicleMotion(motion, { speedMetersPerSecond: 0.1, accuracyMeters: 8 }); assert.equal(motion.moving, true);
  motion = updateVehicleMotion(motion, { speedMetersPerSecond: 0, accuracyMeters: 8 }); assert.equal(motion.moving, false);
  assert.deepEqual(updateVehicleMotion({ moving: true, stationaryConfirmations: 2 }, { speedMetersPerSecond: null, accuracyMeters: 8 }), { moving: true, stationaryConfirmations: 0 });
  assert.equal(updateVehicleMotion({ moving: false, stationaryConfirmations: 0 }, { speedMetersPerSecond: 10, accuracyMeters: 100 }).moving, false);
});

test("navigation is allowlisted, follows the device OS, and telemetry rejects identity, coordinates, and raw URLs", async () => {
  const url = new URL(buildGoogleDirectionsUrl({ kind: "SYNTHETIC_ADDRESS", value: "Synthetic Civic Center" }));
  assert.equal(url.origin, "https://www.google.com"); assert.equal(url.searchParams.get("api"), "1"); assert.equal(url.searchParams.get("travelmode"), "driving"); assert.equal(url.searchParams.has("origin"), false);
  assert.throws(() => buildGoogleDirectionsUrl({ kind: "SYNTHETIC_ADDRESS", value: "Patient Jane oncology appointment" }), /NAVIGATION_ADDRESS_INVALID/);
  assert.equal(new URL(buildAppleMapsUrl({ kind: "SYNTHETIC_ADDRESS", value: "Synthetic Civic Center" })).origin, "https://maps.apple.com");
  const opened = []; const port = { async open(candidate) { opened.push(candidate); } };
  assert.equal(await handoffNavigation(port, { kind: "SYNTHETIC_ADDRESS", value: "Synthetic Civic Center" }, "android"), "OPENED_GOOGLE");
  assert.equal(new URL(opened.at(-1)).origin, "https://www.google.com");
  assert.equal(await handoffNavigation(port, { kind: "SYNTHETIC_ADDRESS", value: "Synthetic Civic Center" }, "ios"), "OPENED_APPLE");
  assert.equal(new URL(opened.at(-1)).origin, "https://maps.apple.com");
  assert.equal(await handoffNavigation({ async open() { throw new Error("unavailable"); } }, { kind: "SYNTHETIC_ADDRESS", value: "Synthetic Civic Center" }, "ios"), "UNAVAILABLE");
  assert.deepEqual(safeDriverTelemetry({ metric: "driver_sync", outcome: "success", state: "LIVE" }), { metric: "driver_sync", outcome: "success", state: "LIVE" });
  for (const prohibited of ["tenantId", "driverId", "latitude", "rawUrl", "cursor", "token"]) assert.throws(() => safeDriverTelemetry({ metric: "driver_sync", outcome: "failure", [prohibited]: "synthetic" }), /PROHIBITED/);
});
