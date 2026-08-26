import assert from "node:assert/strict";
import test from "node:test";
import WebSocket from "ws";
import { createWp007Api, createSyntheticTestVerifier, syntheticIds } from "@kavaroutes/api-contracts";
import {
  authorizeRealtimeSubscription, createAuthorizationGenerationSource, createInMemoryRealtimeStore,
  createTestOnlyCursorCodec, REALTIME_PROTOCOL,
} from "../dist/index.js";
import { registerWp009Realtime } from "../dist/fastify.js";

const scope = Object.freeze({ streamKind: "DISPATCH_DAY", scopeReference: "branch:synthetic-all", serviceDate: "2026-08-25" });

async function fixture() {
  const verifier = createSyntheticTestVerifier();
  const principal = await verifier.verify("Synthetic principal_dispatcher");
  assert.ok(principal);
  const codec = createTestOnlyCursorCodec({ now: () => new Date("2026-08-25T12:00:00.000Z") });
  const store = createInMemoryRealtimeStore(codec, { now: () => new Date("2026-08-25T12:00:00.000Z") });
  const generationSource = createAuthorizationGenerationSource();
  const authorization = authorizeRealtimeSubscription({ principal, organizationId: syntheticIds.organizationA, authorizationGeneration: 1, purpose: "DISPATCH_CONTROL", scope });
  const snapshot = await store.snapshot(authorization);
  const app = await createWp007Api({ verifier });
  const gateway = await registerWp009Realtime(app, { store, generationSource });
  return { app, gateway, store, snapshot };
}

test("REST recovery is body-cursor, no-store, bounded, schema-valid, and authorization-identical", async (t) => {
  const { app, store, snapshot } = await fixture();
  t.after(() => app.close());
  await store.append({ organizationId: syntheticIds.organizationA, sourceEventId: "event:synthetic:rest", purpose: "DISPATCH_CONTROL", scope,
    delta: { kind: "DISPATCH_CONTROL", tripReference: "trip:synthetic:001", lifecycle: "DISPATCHED", resourceVersion: 1 } });
  const url = `/v1/organizations/${syntheticIds.organizationA}/realtime-change-queries`;
  let response = await app.inject({ method: "POST", url, headers: { authorization: "Synthetic principal_dispatcher", "content-type": "application/json" },
    payload: { purpose: "DISPATCH_CONTROL", scope, cursor: snapshot.cursor, limit: 100 } });
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers["cache-control"], "no-store");
  assert.equal(response.json().outcome, "REPLAY");
  assert.equal(response.json().changes.length, 1);
  assert.equal(url.includes("cursor"), false);

  response = await app.inject({ method: "POST", url, headers: { authorization: "Synthetic principal_outsider", "content-type": "application/json" },
    payload: { purpose: "DISPATCH_CONTROL", scope, cursor: snapshot.cursor } });
  assert.equal(response.statusCode, 404);
  response = await app.inject({ method: "POST", url, headers: { authorization: "Synthetic principal_dispatcher", "content-type": "application/json" },
    payload: { purpose: "DISPATCH_CONTROL", scope, cursor: snapshot.cursor, fields: ["raw-event"] } });
  assert.equal(response.statusCode, 400);
});

test("loopback WebSocket authenticates before upgrade, enforces origin/subprotocol, attaches handlers, and drains safely", async (t) => {
  const { app, gateway, snapshot } = await fixture();
  await app.listen({ host: "127.0.0.1", port: 0 });
  t.after(() => app.close());
  const address = app.server.address();
  assert.ok(address && typeof address === "object");
  const url = `ws://127.0.0.1:${address.port}/v1/realtime`;

  const denied = await new Promise((resolve, reject) => {
    const socket = new WebSocket(url, REALTIME_PROTOCOL, { headers: { authorization: "Synthetic principal_dispatcher", origin: "https://evil.test", "x-synthetic-client-class": "synthetic-web" } });
    socket.once("unexpected-response", (_request, response) => { response.resume(); resolve(response.statusCode); });
    socket.once("error", reject);
  });
  assert.equal(denied, 403);

  const frames = await new Promise((resolve, reject) => {
    const socket = new WebSocket(url, REALTIME_PROTOCOL, { perMessageDeflate: false,
      headers: { authorization: "Synthetic principal_dispatcher", origin: "http://kavaroutes.test", "x-synthetic-client-class": "synthetic-web" } });
    const observed = [];
    let live = false;
    socket.on("message", (data) => {
      const frame = JSON.parse(data.toString()); observed.push(frame);
      if (frame.type === "connection.ready") socket.send(JSON.stringify({ type: "subscription.subscribe", messageId: "message:synthetic:ws", subscriptionId: "subscription:synthetic:ws",
        organizationId: syntheticIds.organizationA, purpose: "DISPATCH_CONTROL", scope, cursor: snapshot.cursor }));
      if (frame.type === "subscription.live") { live = true; socket.close(1000, "NORMAL"); }
    });
    socket.once("close", () => { if (live) resolve(observed); });
    socket.once("error", reject);
  });
  assert.deepEqual(frames.map((frame) => frame.type), ["connection.ready", "subscription.live"]);
  for (let attempt = 0; attempt < 20 && gateway.activeConnections() !== 0; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(gateway.activeConnections(), 0);
});
