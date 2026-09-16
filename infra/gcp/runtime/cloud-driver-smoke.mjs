import WebSocket from "ws";

if (process.env.KAVAROUTES_VERIFY_PRIVATE_CLOUD !== "1") {
  throw new Error("PRIVATE_CLOUD_VERIFICATION_NOT_ENABLED");
}

const base = "http://127.0.0.1:58080";
const organizationId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const serviceDate = "2026-09-13";
const assignmentId = "40000000-0000-4000-8000-000000000001";
const idempotencyKey = "driver-shift-shift_synthetic000001";
const driverHeaders = Object.freeze({ authorization: "Synthetic principal_driver", accept: "application/json" });
const dispatcherHeaders = Object.freeze({ authorization: "Synthetic principal_dispatcher", accept: "application/json" });
const scope = Object.freeze({ streamKind: "DISPATCH_DAY", scopeReference: `branch:${organizationId}`, serviceDate });
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function json(response, expectedStatus) {
  if (response.status !== expectedStatus) throw new Error(`UNEXPECTED_STATUS_${response.status}`);
  return response.json();
}

function validateReceipt(value) {
  if (!value || typeof value !== "object" || !["APPLIED", "REPLAYED"].includes(value.outcome) ||
      !uuid.test(value.shiftReference) || !uuid.test(value.shiftGeneration) ||
      value.resourceVersion !== 1 || value.effectivePolicy?.assignmentId !== assignmentId ||
      value.effectivePolicy?.driverId !== "30000000-0000-4000-8000-000000000001") {
    throw new Error("INVALID_SHIFT_RECEIPT");
  }
  return value;
}

let socket;
const timeout = setTimeout(() => {
  console.error("CLOUD_DRIVER_FLOW_TIMEOUT");
  process.exit(1);
}, 30_000);

try {
  const itinerary = await json(await fetch(`${base}/v1/organizations/${organizationId}/driver/itineraries/${serviceDate}`, {
    headers: driverHeaders,
  }), 200);
  if (itinerary.driverReference !== "30000000-0000-4000-8000-000000000001" || itinerary.serviceDate !== serviceDate ||
      itinerary.legs?.length !== 1 || itinerary.legs[0]?.assignmentId !== assignmentId || itinerary.legs[0]?.assignmentVersion !== 1) {
    throw new Error("PERSISTED_ITINERARY_MISMATCH");
  }

  const snapshot = await json(await fetch(`${base}/v1/organizations/${organizationId}/runtime-dispatch-snapshot?serviceDate=${serviceDate}`, {
    headers: dispatcherHeaders,
  }), 200);

  let liveResolve;
  let changeResolve;
  let rejectSocket;
  const failed = new Promise((_, reject) => { rejectSocket = reject; });
  const live = Promise.race([new Promise(resolve => { liveResolve = resolve; }), failed]);
  const changed = Promise.race([new Promise(resolve => { changeResolve = resolve; }), failed]);
  live.catch(() => {});
  changed.catch(() => {});
  socket = new WebSocket("ws://127.0.0.1:58080/v1/realtime", "kavaroutes.realtime.v1", {
    headers: { ...dispatcherHeaders, origin: "http://kavaroutes.test" },
  });
  socket.on("error", rejectSocket);
  socket.on("message", raw => {
    try {
      const frame = JSON.parse(raw);
      if (frame.type === "connection.ready") {
        socket.send(JSON.stringify({ type: "subscription.subscribe", messageId: "message:driver-cloud:1",
          subscriptionId: "subscription:driver-cloud:1", organizationId, purpose: "DISPATCH_CONTROL", scope, cursor: snapshot.cursor }));
      }
      if (frame.type === "subscription.live") liveResolve();
      if (frame.type === "change.batch" && frame.changes.some(change =>
        change.delta?.resourceKind === "driver-shift" && change.delta?.resourceReference?.startsWith("driver-shift:"))) changeResolve();
    } catch (error) { rejectSocket(error); }
  });
  await live;

  const request = Object.freeze({ assignmentId, serviceDate, expectedAssignmentVersion: 1 });
  const command = () => fetch(`${base}/v1/organizations/${organizationId}/driver/shifts/commands/start`, {
    method: "POST",
    headers: { ...driverHeaders, "content-type": "application/json", "idempotency-key": idempotencyKey },
    body: JSON.stringify(request),
  });
  const firstResponse = await command();
  const first = validateReceipt(await json(firstResponse, 200));
  const replayResponse = await command();
  const replay = validateReceipt(await json(replayResponse, 200));
  if (replay.outcome !== "REPLAYED" || replayResponse.headers.get("kavaroutes-idempotency-replayed") !== "true" ||
      first.shiftReference !== replay.shiftReference || first.shiftGeneration !== replay.shiftGeneration ||
      first.effectivePolicy.canonicalDigest !== replay.effectivePolicy.canonicalDigest) throw new Error("SHIFT_REPLAY_MISMATCH");

  if (first.outcome === "APPLIED") await changed;
  const replayedChanges = await json(await fetch(`${base}/v1/organizations/${organizationId}/realtime-change-queries`, {
    method: "POST",
    headers: { ...dispatcherHeaders, "content-type": "application/json" },
    body: JSON.stringify({ purpose: "DISPATCH_CONTROL", scope, cursor: snapshot.cursor, limit: 100 }),
  }), 200);
  const matchingChange = replayedChanges.changes?.find(change =>
    change.delta?.resourceKind === "driver-shift" && change.delta?.resourceReference === `driver-shift:${first.shiftReference}`);
  if (!matchingChange) throw new Error("DRIVER_SHIFT_REALTIME_CHANGE_MISSING_FROM_CAPTURED_CURSOR");

  console.log(JSON.stringify({ result: "CLOUD_DRIVER_ITINERARY_SHIFT_REPLAY_PASSED", firstOutcome: first.outcome,
    itineraryLegs: itinerary.legs.length, replayed: true, realtimeInvalidation: Boolean(matchingChange) }));
} catch (error) {
  console.error(error instanceof Error ? error.message : "CLOUD_DRIVER_FLOW_FAILED");
  process.exitCode = 1;
} finally {
  clearTimeout(timeout);
  socket?.terminate();
}
