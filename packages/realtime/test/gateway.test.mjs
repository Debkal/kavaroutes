import assert from "node:assert/strict";
import test from "node:test";
import { createSyntheticTestVerifier, syntheticIds } from "@kavaroutes/api-contracts";
import {
  authorizeRealtimeSubscription, createAuthorizationGenerationSource, createInMemoryRealtimeStore,
  createNotificationPollFanout, createRealtimeGateway, createTestOnlyCursorCodec, REALTIME_LIMITS, REALTIME_PROTOCOL,
} from "../dist/index.js";

const scope = Object.freeze({ streamKind: "DISPATCH_DAY", scopeReference: "branch:synthetic-all", serviceDate: "2026-08-25" });
const verifier = createSyntheticTestVerifier();

function transport() {
  const sent = [];
  const state = { buffered: 0, closed: null, terminated: false, pings: 0 };
  return {
    get bufferedAmount() { return state.buffered; },
    send(text) { sent.push(JSON.parse(text)); }, ping() { state.pings += 1; }, close(code, reason) { state.closed = { code, reason }; }, terminate() { state.terminated = true; },
    sent, state,
  };
}

async function setup(clock = new Date("2026-08-25T12:00:00.000Z")) {
  const principal = await verifier.verify("Synthetic principal_dispatcher");
  assert.ok(principal);
  const generationSource = createAuthorizationGenerationSource();
  const codec = createTestOnlyCursorCodec({ now: () => clock });
  const store = createInMemoryRealtimeStore(codec, { now: () => clock });
  const authorization = authorizeRealtimeSubscription({ principal, organizationId: syntheticIds.organizationA, authorizationGeneration: 1, purpose: "DISPATCH_CONTROL", scope });
  const snapshot = await store.snapshot(authorization);
  return { principal, generationSource, store, authorization, snapshot };
}

test("gateway requires exact origin/protocol and performs replay, live fanout, unsubscribe, and revocation", async () => {
  const fixture = await setup();
  const metrics = [];
  const gateway = createRealtimeGateway({ store: fixture.store, generationSource: fixture.generationSource, telemetrySink: (event) => metrics.push(event) });
  assert.throws(() => gateway.open({ principal: fixture.principal, origin: "https://evil.test", protocol: REALTIME_PROTOCOL, clientClass: "synthetic-web", transport: transport() }), /AUTHORIZATION_DENIED/);
  assert.throws(() => gateway.open({ principal: fixture.principal, origin: "http://kavaroutes.test", protocol: "other", clientClass: "synthetic-web", transport: transport() }), /FRAME_INVALID/);

  const socket = transport();
  const id = gateway.open({ principal: fixture.principal, origin: "http://kavaroutes.test", protocol: REALTIME_PROTOCOL, clientClass: "synthetic-web", transport: socket });
  assert.equal(socket.sent[0].type, "connection.ready");
  await gateway.receive(id, JSON.stringify({ type: "subscription.subscribe", messageId: "message:synthetic:001", subscriptionId: "subscription:synthetic:001",
    organizationId: syntheticIds.organizationA, purpose: "DISPATCH_CONTROL", scope, cursor: fixture.snapshot.cursor }));
  assert.equal(socket.sent.at(-1).type, "subscription.live");
  await fixture.store.append({ organizationId: syntheticIds.organizationA, sourceEventId: "event:synthetic:fanout", purpose: "DISPATCH_CONTROL", scope,
    delta: { kind: "DISPATCH_CONTROL", tripReference: "trip:synthetic:001", lifecycle: "DISPATCHED", resourceVersion: 1 } });
  assert.equal(await gateway.fanOut(), 1);
  assert.equal(socket.sent.at(-1).type, "change.batch");
  fixture.generationSource.revoke(fixture.principal.id);
  gateway.authorizationSweep();
  assert.equal(socket.sent.at(-1).type, "subscription.revoked");
  assert.ok(metrics.every((event) => !JSON.stringify(event).includes(syntheticIds.organizationA)));
});

test("gateway bounds binary, malformed, oversized, flood, slow-client, heartbeat, presence, and drain behavior", async () => {
  let clock = new Date("2026-08-25T12:00:00.000Z");
  const fixture = await setup(clock);
  const gateway = createRealtimeGateway({ store: fixture.store, generationSource: fixture.generationSource, now: () => clock });
  const binary = transport();
  const binaryId = gateway.open({ principal: fixture.principal, protocol: REALTIME_PROTOCOL, clientClass: "synthetic-native", origin: undefined, transport: binary });
  await gateway.receive(binaryId, Buffer.from([1, 2, 3]), true);
  assert.equal(binary.state.closed.code, 1003);

  const malformed = transport();
  const malformedId = gateway.open({ principal: fixture.principal, protocol: REALTIME_PROTOCOL, clientClass: "synthetic-native", origin: undefined, transport: malformed });
  await gateway.receive(malformedId, "{not-json");
  assert.equal(malformed.state.closed.code, 1007);

  const oversized = transport();
  const oversizedId = gateway.open({ principal: fixture.principal, protocol: REALTIME_PROTOCOL, clientClass: "synthetic-native", origin: undefined, transport: oversized });
  await gateway.receive(oversizedId, Buffer.alloc(REALTIME_LIMITS.maximumInboundBytes + 1));
  assert.equal(oversized.state.closed.code, 1009);

  const slow = transport();
  const slowId = gateway.open({ principal: fixture.principal, protocol: REALTIME_PROTOCOL, clientClass: "synthetic-native", origin: undefined, transport: slow });
  slow.state.buffered = REALTIME_LIMITS.maximumQueuedBytes;
  await gateway.receive(slowId, JSON.stringify({ type: "subscription.subscribe", messageId: "message:synthetic:slow", subscriptionId: "subscription:synthetic:slow",
    organizationId: syntheticIds.organizationA, purpose: "DISPATCH_CONTROL", scope, cursor: fixture.snapshot.cursor }));
  assert.equal(slow.state.closed.code, 1013);

  const heartbeat = transport();
  gateway.open({ principal: fixture.principal, protocol: REALTIME_PROTOCOL, clientClass: "synthetic-native", origin: undefined, transport: heartbeat });
  assert.equal(gateway.presence().length, 1);
  assert.deepEqual(Object.keys(gateway.presence()[0]).sort(), ["clientClass", "connectionId", "expiresAt", "lastObservedAt", "safeScopeClass"]);
  clock = new Date(clock.getTime() + REALTIME_LIMITS.deadPeerGraceMilliseconds + 1);
  gateway.heartbeatSweep();
  assert.equal(heartbeat.state.terminated, true);

  const drain = transport();
  gateway.open({ principal: fixture.principal, protocol: REALTIME_PROTOCOL, clientClass: "synthetic-native", origin: undefined, transport: drain });
  gateway.drain();
  assert.equal(drain.sent.at(-1).type, "server.draining");
  assert.equal(drain.state.closed.code, 1012);
  assert.throws(() => gateway.open({ principal: fixture.principal, protocol: REALTIME_PROTOCOL, clientClass: "synthetic-native", origin: undefined, transport: transport() }), /RATE_LIMITED/);
});

test("notification plus polling coalesces concurrent wakes and polling recovers a missed notification", async () => {
  let wake;
  let stopped = false;
  let calls = 0;
  const source = { async start(handler) { wake = handler; }, async stop() { stopped = true; }, async queueUsage() { return 0.125; } };
  const fanout = createNotificationPollFanout({ wakeSource: source, pollMilliseconds: 60_000, fanOut: async () => { calls += 1; return 0; } });
  await fanout.start();
  assert.equal(calls, 1);
  wake("");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 2);
  await fanout.poll();
  assert.equal(calls, 3);
  assert.equal(await fanout.queueUsage(), 0.125);
  assert.throws(() => wake("tenant-data"), /PAYLOAD_PROHIBITED/);
  await fanout.stop();
  assert.equal(stopped, true);
});
