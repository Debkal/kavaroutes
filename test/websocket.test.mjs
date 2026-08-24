import assert from "node:assert/strict";
import test from "node:test";
import WebSocket from "ws";
import { createApi } from "@kavaroutes/api-host";

test("WebSocket lifecycle rejects missing context and safely closes after a bounded message", async (t) => {
  const app = await createApi({ operationIdFactory: () => "op_socket_test_001" });
  await app.listen({ host: "127.0.0.1", port: 0 });
  t.after(() => app.close());
  const address = app.server.address();
  assert.ok(address && typeof address === "object");
  const url = `ws://127.0.0.1:${address.port}/platform/v1/socket-probe`;

  const rejection = await new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    socket.once("unexpected-response", (_request, response) => { response.resume(); resolve(response.statusCode); });
    socket.once("error", reject);
  });
  assert.equal(rejection, 400);

  const result = await new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { headers: { "x-synthetic-context": "accepted" }, maxPayload: 1024 });
    let notification;
    socket.once("message", (data) => { notification = JSON.parse(data.toString()); socket.send("not-supported"); });
    socket.once("close", (code, reason) => resolve({ code, reason: reason.toString(), notification }));
    socket.once("error", reject);
  });
  assert.equal(result.code, 1008);
  assert.equal(result.reason, "messages_not_supported");
  assert.deepEqual(result.notification, {
    type: "wp005.synthetic.notification",
    operationId: "op_socket_test_001",
    sequence: 1
  });
});
