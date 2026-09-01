import assert from "node:assert/strict";
import test from "node:test";
import { createSyntheticTestVerifier, syntheticIds } from "@kavaroutes/api-contracts";
import {
  authorizeRealtimeSubscription, createAuthorizationGenerationSource, createInMemoryRealtimeStore,
  createMemoryClientProjection, createReferenceSyncClient, createTestOnlyCursorCodec, CursorRejected,
  decodeClientFrame, locationShard, positionFreshness, PROTOCOL_CATALOG, REALTIME_LIMITS, realtimeSchemas, reconnectDelay,
} from "../dist/index.js";

const dispatcherScope = Object.freeze({ streamKind: "DISPATCH_DAY", scopeReference: "branch:synthetic-all", serviceDate: "2026-08-25" });
const locationScope = Object.freeze({ streamKind: "CURRENT_POSITION", scopeReference: "fleet:synthetic-all" });
const verifier = createSyntheticTestVerifier();

async function authorization(scope = dispatcherScope, purpose = "DISPATCH_CONTROL", principalName = "principal_dispatcher") {
  const principal = await verifier.verify(`Synthetic ${principalName}`);
  assert.ok(principal);
  return authorizeRealtimeSubscription({ principal, organizationId: syntheticIds.organizationA, authorizationGeneration: 1, purpose, scope });
}

test("catalog and closed schemas define the exact private bounded protocol", () => {
  assert.equal(PROTOCOL_CATALOG.protocol, "kavaroutes.realtime.v1");
  assert.equal(PROTOCOL_CATALOG.privateProtocol, true);
  assert.equal(PROTOCOL_CATALOG.ianaRegistered, false);
  assert.deepEqual(PROTOCOL_CATALOG.clientFrames, ["subscription.subscribe", "subscription.unsubscribe", "subscription.ack"]);
  assert.equal(REALTIME_LIMITS.maximumInboundBytes, 65_536);
  assert.equal(REALTIME_LIMITS.maximumOutboundBatchBytes, 262_144);
  assert.equal(REALTIME_LIMITS.maximumChangesPerBatch, 100);
  for (const schema of realtimeSchemas.filter((item) => item.type === "object")) assert.equal(schema.additionalProperties, false, schema.$id);
  assert.throws(() => decodeClientFrame(JSON.stringify({ type: "subscription.ack", messageId: "message:test:001", subscriptionId: "subscription:test:001", cursor: "rtc1.invalid", command: "CancelTrip" })), /FRAME_INVALID/);
  assert.throws(() => decodeClientFrame(Buffer.alloc(REALTIME_LIMITS.maximumInboundBytes + 1)), /FRAME_TOO_LARGE/);
});

test("encrypted cursors hide claims and fail closed on every binding and lifetime mismatch", async () => {
  let clock = new Date("2026-08-25T12:00:00.000Z");
  const codec = createTestOnlyCursorCodec({ now: () => clock, nonceFactory: () => Buffer.alloc(12, 7) });
  const auth = await authorization();
  const token = codec.encode({ organizationId: auth.organizationId, principalId: auth.principalId, authorizationGeneration: 1,
    purpose: auth.purpose, scope: auth.scope, vectors: [{ streamId: "11111111-1111-4111-8111-111111111111", epoch: 1, sequence: 4 }], lifetimeMilliseconds: 60_000 });
  assert.match(token, /^rtc1\./);
  for (const readable of [auth.organizationId, auth.principalId, "DISPATCH_CONTROL", "branch:synthetic-all"]) assert.equal(token.includes(readable), false);
  const decoded = codec.decode(token, { organizationId: auth.organizationId, principalId: auth.principalId, authorizationGeneration: 1, purpose: auth.purpose, scope: auth.scope });
  assert.equal(decoded.vectors[0].sequence, 4);
  assert.throws(() => codec.decode(`${token.slice(0, -1)}A`, { organizationId: auth.organizationId, principalId: auth.principalId, authorizationGeneration: 1, purpose: auth.purpose, scope: auth.scope }), CursorRejected);
  assert.throws(() => codec.decode(token, { organizationId: syntheticIds.organizationB, principalId: auth.principalId, authorizationGeneration: 1, purpose: auth.purpose, scope: auth.scope }), CursorRejected);
  assert.throws(() => codec.decode(token, { organizationId: auth.organizationId, principalId: auth.principalId, authorizationGeneration: 2, purpose: auth.purpose, scope: auth.scope }), CursorRejected);
  const rotated = createTestOnlyCursorCodec({ keyReference: "test-only-key-v2", now: () => clock });
  assert.throws(() => rotated.decode(token, { organizationId: auth.organizationId, principalId: auth.principalId, authorizationGeneration: 1, purpose: auth.purpose, scope: auth.scope }),
    (error) => error instanceof CursorRejected && error.reason === "KEY_VERSION_UNKNOWN");
  clock = new Date("2026-08-25T12:01:01.000Z");
  assert.throws(() => codec.decode(token, { organizationId: auth.organizationId, principalId: auth.principalId, authorizationGeneration: 1, purpose: auth.purpose, scope: auth.scope }), CursorRejected);
});

test("ordered authorization enforces organization, capability, purpose, relationship, location policy, and cost", async () => {
  const dispatch = await authorization();
  assert.deepEqual([...dispatch.allowedDeltaKinds], ["RESOURCE_INVALIDATED", "DISPATCH_CONTROL"]);
  const location = await authorization(locationScope, "DISPATCH_CURRENT_POSITION");
  assert.deepEqual([...location.allowedDeltaKinds], ["CURRENT_POSITION"]);
  await assert.rejects(() => authorization(dispatcherScope, "DISPATCH_CONTROL", "principal_outsider"), /REALTIME_AUTHORIZATION_DENIED/);
  const principal = await verifier.verify("Synthetic principal_dispatcher");
  assert.ok(principal);
  const withoutLocation = { ...principal, capabilities: new Set([...principal.capabilities].filter((item) => item !== "dispatch:location:read")) };
  assert.throws(() => authorizeRealtimeSubscription({ principal: withoutLocation, organizationId: syntheticIds.organizationA, authorizationGeneration: 1, purpose: "DISPATCH_CURRENT_POSITION", scope: locationScope }), /REALTIME_AUTHORIZATION_DENIED/);
  const generations = createAuthorizationGenerationSource();
  assert.equal(generations.current(principal.id), 1);
  assert.equal(generations.revoke(principal.id), 2);
});

test("snapshot watermark, replay, duplicate, coalescing, expiry/reset, and vector shards converge", async () => {
  let clock = new Date("2026-08-25T12:00:00.000Z");
  const codec = createTestOnlyCursorCodec({ now: () => clock });
  const store = createInMemoryRealtimeStore(codec, { now: () => clock });
  const auth = await authorization();
  const snapshot = await store.snapshot(auth);
  await store.append({ organizationId: syntheticIds.organizationA, sourceEventId: "event:synthetic:001", purpose: "DISPATCH_CONTROL", scope: dispatcherScope,
    delta: { kind: "DISPATCH_CONTROL", tripReference: "trip:synthetic:001", lifecycle: "DISPATCHED", resourceVersion: 1 }, committedAt: clock });
  assert.equal(await store.append({ organizationId: syntheticIds.organizationA, sourceEventId: "event:synthetic:001", purpose: "DISPATCH_CONTROL", scope: dispatcherScope,
    delta: { kind: "DISPATCH_CONTROL", tripReference: "trip:synthetic:001", lifecycle: "DISPATCHED", resourceVersion: 1 } }), "DUPLICATE");
  let replay = await store.replay(auth, snapshot.cursor);
  assert.equal(replay.outcome, "REPLAY");
  assert.equal(replay.changes.length, 1);
  assert.equal((await store.replay(auth, replay.cursor)).changes.length, 0);

  const locationAuth = await authorization(locationScope, "DISPATCH_CURRENT_POSITION");
  const locationSnapshot = await store.snapshot(locationAuth);
  const position = (event, version, milliseconds) => store.append({ organizationId: syntheticIds.organizationA, sourceEventId: event,
    purpose: "DISPATCH_CURRENT_POSITION", scope: { ...locationScope, shard: locationShard("driver:synthetic:001", 8) }, committedAt: new Date(clock.getTime() + milliseconds),
    delta: { kind: "CURRENT_POSITION", driverReference: "driver:synthetic:001", latitude: 34.1, longitude: -118.2, accuracyMeters: 5, capturedAt: new Date(clock.getTime() + milliseconds).toISOString(), resourceVersion: version } });
  assert.equal(await position("event:location:001", 1, 0), "APPLIED");
  assert.equal(await position("event:location:002", 2, 100), "COALESCED");
  const positions = await store.replay(locationAuth, locationSnapshot.cursor);
  assert.equal(positions.changes.length, 1);
  assert.equal(positions.changes[0].delta.resourceVersion, 2);
  assert.equal(store.coalescedCount(), 1);
  const vector = store.vector(auth)[0];
  store.compactBefore(vector.streamId, 2);
  assert.equal((await store.replay(auth, snapshot.cursor)).outcome, "RESET_REQUIRED");
});

test("reference client advances cursor after durable apply and stops on gaps, regressions, or unknown schema", async () => {
  const persistence = createMemoryClientProjection();
  const client = createReferenceSyncClient(persistence);
  client.transition("AUTHENTICATING");
  client.transition("REPLAYING");
  const change = { streamId: "11111111-1111-4111-8111-111111111111", epoch: 1, sequence: 1, schemaVersion: "realtime.schema.v1", committedAt: "2026-08-25T12:00:00.000Z",
    delta: { kind: "DISPATCH_CONTROL", tripReference: "trip:synthetic:001", lifecycle: "DISPATCHED", resourceVersion: 2 } };
  assert.equal(await client.applyBatch([change], "rtc1.synthetic-cursor-value-that-is-long-enough-for-test-0001"), "APPLIED");
  client.transition("LIVE");
  assert.equal(await client.applyBatch([change], "rtc1.synthetic-cursor-value-that-is-long-enough-for-test-0001"), "DUPLICATE");
  assert.equal(await client.applyBatch([{ ...change, sequence: 3 }], "rtc1.synthetic-cursor-value-that-is-long-enough-for-test-0002"), "GAP");
  assert.equal(client.state(), "STALE");
  assert.equal(reconnectDelay(0, () => 1), 250);
  assert.ok(reconnectDelay(20, () => 1) <= 30_000);
  assert.equal(positionFreshness("2026-08-25T12:00:00.000Z", new Date("2026-08-25T12:00:15.000Z")), "FRESH");
  assert.equal(positionFreshness("2026-08-25T12:00:00.000Z", new Date("2026-08-25T12:00:59.999Z")), "DELAYED");
  assert.equal(positionFreshness("2026-08-25T12:00:00.000Z", new Date("2026-08-25T12:01:00.000Z")), "STALE");

  let failPersist = true;
  const failing = createReferenceSyncClient(createMemoryClientProjection({ failPersist: () => failPersist }));
  failing.transition("AUTHENTICATING"); failing.transition("REPLAYING");
  await assert.rejects(() => failing.applyBatch([change], "rtc1.synthetic-cursor-value-that-is-long-enough-for-test-0003"), /CURSOR_FAILURE/);
  failPersist = false;
  assert.equal(await failing.applyBatch([change], "rtc1.synthetic-cursor-value-that-is-long-enough-for-test-0003"), "APPLIED");
});

test("reference client gap classifications preserve epoch, schema, and resource-version boundaries", async () => {
  const initial = { streamId: "11111111-1111-4111-8111-111111111111", epoch: 1, sequence: 1, schemaVersion: "realtime.schema.v1", committedAt: "2026-08-25T12:00:00.000Z",
    delta: { kind: "DISPATCH_CONTROL", tripReference: "trip:synthetic:001", lifecycle: "DISPATCHED", resourceVersion: 2 } };
  const cases = [
    { name: "epoch mismatch", candidate: { ...initial, epoch: 2, sequence: 2 } },
    { name: "schema mismatch", candidate: { ...initial, sequence: 2, schemaVersion: "realtime.schema.future" } },
    { name: "resource regression", candidate: { ...initial, streamId: "22222222-2222-4222-8222-222222222222", delta: { ...initial.delta, resourceVersion: 1 } } },
  ];
  for (const { name, candidate } of cases) {
    const client = createReferenceSyncClient(createMemoryClientProjection());
    client.transition("AUTHENTICATING"); client.transition("REPLAYING");
    assert.equal(await client.applyBatch([initial], `rtc1.${name}.initial.cursor.value.000000000000000000000000`), "APPLIED");
    client.transition("LIVE");
    assert.equal(await client.applyBatch([candidate], `rtc1.${name}.candidate.cursor.value.0000000000000000000000`), "GAP", name);
    assert.equal(client.state(), "STALE", name);
  }
});
