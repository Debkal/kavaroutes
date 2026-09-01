import assert from "node:assert/strict";
import test from "node:test";
import { createSyntheticTestVerifier, syntheticIds } from "@kavaroutes/api-contracts";
import {
  authorizeRealtimeSubscription, createAuthorizationGenerationSource, createInMemoryRealtimeStore,
  createNotificationPollFanout, createRealtimeGateway, createTestOnlyCursorCodec, REALTIME_LIMITS, REALTIME_PROTOCOL,
} from "../dist/index.js";

const scope = Object.freeze({ streamKind: "DISPATCH_DAY", scopeReference: "branch:synthetic-all", serviceDate: "2026-08-25" });
const verifier = createSyntheticTestVerifier();

function transport(failures = {}) {
  const sent = [];
  const state = { buffered: 0, closed: null, terminated: false, pings: 0, closeAttempts: 0, terminateAttempts: 0 };
  return {
    get bufferedAmount() { if (failures.bufferedAmount) throw new Error("synthetic bufferedAmount failure"); return state.buffered; },
    send(text) { if (failures.send?.(text)) throw new Error("synthetic send failure"); sent.push(JSON.parse(text)); },
    ping() { state.pings += 1; if (failures.ping) throw new Error("synthetic ping failure"); },
    close(code, reason) { state.closeAttempts += 1; if (failures.close) throw new Error("synthetic close failure"); state.closed = { code, reason }; },
    terminate() { state.terminateAttempts += 1; if (failures.terminate) throw new Error("synthetic terminate failure"); state.terminated = true; },
    sent, state,
  };
}

async function setup(clock = new Date("2026-08-25T12:00:00.000Z")) {
  const principal = await verifier.verify("Synthetic principal_dispatcher");
  const nativePrincipal = await verifier.verify("Synthetic principal_driver");
  assert.ok(principal);
  assert.ok(nativePrincipal);
  const generationSource = createAuthorizationGenerationSource();
  const codec = createTestOnlyCursorCodec({ now: () => clock });
  const store = createInMemoryRealtimeStore(codec, { now: () => clock });
  const authorization = authorizeRealtimeSubscription({ principal, organizationId: syntheticIds.organizationA, authorizationGeneration: 1, purpose: "DISPATCH_CONTROL", scope });
  const snapshot = await store.snapshot(authorization);
  return { principal, nativePrincipal, generationSource, store, authorization, snapshot };
}

test("gateway requires exact origin/protocol and performs replay, live fanout, unsubscribe, and revocation", async () => {
  const fixture = await setup();
  const metrics = [];
  const gateway = createRealtimeGateway({ store: fixture.store, generationSource: fixture.generationSource, telemetrySink: (event) => metrics.push(event) });
  assert.throws(() => gateway.open({ principal: fixture.principal, origin: "https://evil.test", protocol: REALTIME_PROTOCOL, transport: transport() }), /AUTHORIZATION_DENIED/);
  assert.throws(() => gateway.open({ principal: fixture.principal, origin: undefined, protocol: REALTIME_PROTOCOL, clientClass: "synthetic-native", transport: transport() }), /AUTHORIZATION_DENIED/);
  assert.throws(() => gateway.open({ principal: fixture.principal, origin: "http://kavaroutes.test", protocol: "other", transport: transport() }), /FRAME_INVALID/);

  const socket = transport();
  const id = gateway.open({ principal: fixture.principal, origin: "http://kavaroutes.test", protocol: REALTIME_PROTOCOL, transport: socket });
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
  const binaryId = gateway.open({ principal: fixture.nativePrincipal, protocol: REALTIME_PROTOCOL, origin: undefined, transport: binary });
  await gateway.receive(binaryId, Buffer.from([1, 2, 3]), true);
  assert.equal(binary.state.closed.code, 1003);

  const malformed = transport();
  const malformedId = gateway.open({ principal: fixture.nativePrincipal, protocol: REALTIME_PROTOCOL, origin: undefined, transport: malformed });
  await gateway.receive(malformedId, "{not-json");
  assert.equal(malformed.state.closed.code, 1007);

  const oversized = transport();
  const oversizedId = gateway.open({ principal: fixture.nativePrincipal, protocol: REALTIME_PROTOCOL, origin: undefined, transport: oversized });
  await gateway.receive(oversizedId, Buffer.alloc(REALTIME_LIMITS.maximumInboundBytes + 1));
  assert.equal(oversized.state.closed.code, 1009);

  const slow = transport();
  const slowId = gateway.open({ principal: fixture.nativePrincipal, protocol: REALTIME_PROTOCOL, origin: undefined, transport: slow });
  slow.state.buffered = REALTIME_LIMITS.maximumQueuedBytes;
  await gateway.receive(slowId, JSON.stringify({ type: "subscription.subscribe", messageId: "message:synthetic:slow", subscriptionId: "subscription:synthetic:slow",
    organizationId: syntheticIds.organizationA, purpose: "DISPATCH_CONTROL", scope, cursor: fixture.snapshot.cursor }));
  assert.equal(slow.state.closed.code, 1013);
  assert.equal(gateway.activeConnections(), 0);

  const heartbeat = transport();
  gateway.open({ principal: fixture.nativePrincipal, protocol: REALTIME_PROTOCOL, origin: undefined, transport: heartbeat });
  assert.equal(gateway.presence().length, 1);
  assert.deepEqual(Object.keys(gateway.presence()[0]).sort(), ["clientClass", "connectionId", "expiresAt", "lastObservedAt", "safeScopeClass"]);
  clock = new Date(clock.getTime() + REALTIME_LIMITS.deadPeerGraceMilliseconds + 1);
  gateway.heartbeatSweep();
  assert.equal(heartbeat.state.terminated, true);

  const drain = transport();
  gateway.open({ principal: fixture.nativePrincipal, protocol: REALTIME_PROTOCOL, origin: undefined, transport: drain });
  gateway.drain();
  assert.equal(drain.sent.at(-1).type, "server.draining");
  assert.equal(drain.state.closed.code, 1012);
  assert.throws(() => gateway.open({ principal: fixture.nativePrincipal, protocol: REALTIME_PROTOCOL, origin: undefined, transport: transport() }), /RATE_LIMITED/);
});

test("transport failures detach only the affected connection and never abort lifecycle sweeps", async () => {
  let clock = new Date("2026-08-25T12:00:00.000Z");
  const fixture = await setup(clock);
  const metrics = [];
  const gateway = createRealtimeGateway({ store: fixture.store, generationSource: fixture.generationSource, now: () => clock,
    telemetrySink: (event) => { metrics.push(event); if (event.metric === "upgrade") throw new Error("synthetic telemetry failure"); } });

  const failedReady = transport({ send: () => true });
  assert.throws(() => gateway.open({ principal: fixture.nativePrincipal, protocol: REALTIME_PROTOCOL, origin: undefined, transport: failedReady }), /INTERNAL_ERROR/);
  assert.equal(gateway.activeConnections(), 0);
  assert.equal(failedReady.state.closed.code, 1011);

  const failedBufferInspection = transport({ bufferedAmount: true });
  assert.throws(() => gateway.open({ principal: fixture.nativePrincipal, protocol: REALTIME_PROTOCOL, origin: undefined, transport: failedBufferInspection }), /INTERNAL_ERROR/);
  assert.equal(failedBufferInspection.state.closed.code, 1011);
  assert.equal(gateway.activeConnections(), 0);

  const failedPing = transport({ ping: true });
  const healthyPing = transport();
  gateway.open({ principal: fixture.nativePrincipal, protocol: REALTIME_PROTOCOL, origin: undefined, transport: failedPing });
  gateway.open({ principal: fixture.nativePrincipal, protocol: REALTIME_PROTOCOL, origin: undefined, transport: healthyPing });
  assert.doesNotThrow(() => gateway.heartbeatSweep());
  assert.equal(failedPing.state.closed.code, 1011);
  assert.equal(healthyPing.state.pings, 1);
  assert.equal(gateway.activeConnections(), 1);

  const failedClose = transport({ close: true });
  const failedCloseId = gateway.open({ principal: fixture.nativePrincipal, protocol: REALTIME_PROTOCOL, origin: undefined, transport: failedClose });
  assert.doesNotThrow(() => gateway.close(failedCloseId));
  assert.equal(failedClose.state.terminateAttempts, 1);
  assert.equal(failedClose.state.terminated, true);
  assert.equal(gateway.activeConnections(), 1);

  const failedTerminate = transport({ terminate: true });
  const healthyTerminate = transport();
  gateway.open({ principal: fixture.nativePrincipal, protocol: REALTIME_PROTOCOL, origin: undefined, transport: failedTerminate });
  gateway.open({ principal: fixture.nativePrincipal, protocol: REALTIME_PROTOCOL, origin: undefined, transport: healthyTerminate });
  clock = new Date(clock.getTime() + REALTIME_LIMITS.deadPeerGraceMilliseconds + 1);
  assert.doesNotThrow(() => gateway.heartbeatSweep());
  assert.equal(failedTerminate.state.terminateAttempts, 1);
  assert.equal(healthyTerminate.state.terminated, true);
  assert.equal(gateway.activeConnections(), 0);
  assert.ok(metrics.filter((event) => event.metric === "transport_failure").length >= 5);
  assert.ok(metrics.every((event) => !JSON.stringify(event).includes(fixture.principal.id)));
});

test("fanout isolates failed stores and sockets while healthy subscriptions continue in order", async () => {
  const fixture = await setup();
  let failNextReplay = false;
  const store = {
    async replay(...args) {
      if (failNextReplay) { failNextReplay = false; throw new Error("synthetic store failure"); }
      return fixture.store.replay(...args);
    }
  };
  const metrics = [];
  const gateway = createRealtimeGateway({ store, generationSource: fixture.generationSource, telemetrySink: (event) => metrics.push(event) });
  const failedStoreSocket = transport();
  const healthySocket = transport();
  const failedStoreId = gateway.open({ principal: fixture.principal, origin: "http://kavaroutes.test", protocol: REALTIME_PROTOCOL, transport: failedStoreSocket });
  const healthyId = gateway.open({ principal: fixture.principal, origin: "http://kavaroutes.test", protocol: REALTIME_PROTOCOL, transport: healthySocket });
  for (const [id, suffix] of [[failedStoreId, "failed-store"], [healthyId, "healthy"]]) {
    await gateway.receive(id, JSON.stringify({ type: "subscription.subscribe", messageId: `message:synthetic:${suffix}`, subscriptionId: `subscription:synthetic:${suffix}`,
      organizationId: syntheticIds.organizationA, purpose: "DISPATCH_CONTROL", scope, cursor: fixture.snapshot.cursor }));
  }
  await fixture.store.append({ organizationId: syntheticIds.organizationA, sourceEventId: "event:synthetic:fault-isolation-1", purpose: "DISPATCH_CONTROL", scope,
    delta: { kind: "DISPATCH_CONTROL", tripReference: "trip:synthetic:fault-isolation-1", lifecycle: "DISPATCHED", resourceVersion: 1 } });
  failNextReplay = true;
  assert.equal(await gateway.fanOut(), 1);
  assert.equal(failedStoreSocket.sent.at(-1).code, "INTERNAL_ERROR");
  assert.equal(failedStoreSocket.state.closed.code, 1011);
  assert.equal(healthySocket.sent.at(-1).type, "change.batch");
  assert.equal(gateway.activeConnections(), 1);

  let failChangeBatch = false;
  const failedSendSocket = transport({ send: (text) => failChangeBatch && JSON.parse(text).type === "change.batch" });
  const secondHealthySocket = transport();
  const failedSendId = gateway.open({ principal: fixture.principal, origin: "http://kavaroutes.test", protocol: REALTIME_PROTOCOL, transport: failedSendSocket });
  const secondHealthyId = gateway.open({ principal: fixture.principal, origin: "http://kavaroutes.test", protocol: REALTIME_PROTOCOL, transport: secondHealthySocket });
  for (const [id, suffix] of [[failedSendId, "failed-send"], [secondHealthyId, "second-healthy"]]) {
    await gateway.receive(id, JSON.stringify({ type: "subscription.subscribe", messageId: `message:synthetic:${suffix}`, subscriptionId: `subscription:synthetic:${suffix}`,
      organizationId: syntheticIds.organizationA, purpose: "DISPATCH_CONTROL", scope, cursor: fixture.snapshot.cursor }));
  }
  await fixture.store.append({ organizationId: syntheticIds.organizationA, sourceEventId: "event:synthetic:fault-isolation-2", purpose: "DISPATCH_CONTROL", scope,
    delta: { kind: "DISPATCH_CONTROL", tripReference: "trip:synthetic:fault-isolation-2", lifecycle: "DISPATCHED", resourceVersion: 2 } });
  failChangeBatch = true;
  assert.equal(await gateway.fanOut(), 2);
  assert.equal(failedSendSocket.state.closed.code, 1011);
  assert.equal(secondHealthySocket.sent.at(-1).type, "change.batch");
  assert.equal(gateway.activeConnections(), 2);
  assert.ok(metrics.some((event) => event.metric === "store_failure"));
  assert.ok(metrics.some((event) => event.metric === "transport_failure"));
});

test("authorization and drain failures remain connection-local", async () => {
  const fixture = await setup();
  let sweep = false;
  let sweepCalls = 0;
  const generationSource = {
    current() {
      if (!sweep) return 1;
      if (sweepCalls++ === 0) throw new Error("synthetic authorization source failure");
      return 2;
    }
  };
  const metrics = [];
  const gateway = createRealtimeGateway({ store: fixture.store, generationSource, telemetrySink: (event) => metrics.push(event) });
  const failedSourceSocket = transport();
  const revokedSocket = transport();
  const failedSourceId = gateway.open({ principal: fixture.principal, origin: "http://kavaroutes.test", protocol: REALTIME_PROTOCOL, transport: failedSourceSocket });
  const revokedId = gateway.open({ principal: fixture.principal, origin: "http://kavaroutes.test", protocol: REALTIME_PROTOCOL, transport: revokedSocket });
  for (const [id, suffix] of [[failedSourceId, "failed-source"], [revokedId, "revoked"]]) {
    await gateway.receive(id, JSON.stringify({ type: "subscription.subscribe", messageId: `message:synthetic:${suffix}`, subscriptionId: `subscription:synthetic:${suffix}`,
      organizationId: syntheticIds.organizationA, purpose: "DISPATCH_CONTROL", scope, cursor: fixture.snapshot.cursor }));
  }
  sweep = true;
  assert.doesNotThrow(() => gateway.authorizationSweep());
  assert.equal(failedSourceSocket.state.closed.code, 1011);
  assert.equal(revokedSocket.sent.at(-1).type, "subscription.revoked");
  assert.equal(gateway.activeConnections(), 1);

  const failedDrain = transport({ send: (text) => JSON.parse(text).type === "server.draining" });
  const healthyDrain = transport();
  gateway.open({ principal: fixture.nativePrincipal, origin: undefined, protocol: REALTIME_PROTOCOL, transport: failedDrain });
  gateway.open({ principal: fixture.nativePrincipal, origin: undefined, protocol: REALTIME_PROTOCOL, transport: healthyDrain });
  assert.doesNotThrow(() => gateway.drain());
  assert.equal(failedDrain.state.closed.code, 1011);
  assert.equal(healthyDrain.sent.at(-1).type, "server.draining");
  assert.equal(healthyDrain.state.closed.code, 1012);
  assert.equal(gateway.activeConnections(), 0);
  assert.ok(metrics.some((event) => event.metric === "dependency_failure"));
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
