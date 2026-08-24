import assert from "node:assert/strict";
import { Writable } from "node:stream";
import test from "node:test";
import pino from "pino";
import { safePinoOptions } from "@kavaroutes/api-host/logging";
import { safeTelemetryAttributes } from "@kavaroutes/api-host/telemetry";
import { forbiddenCanaries } from "@kavaroutes/platform-test-support";

test("allowlisted telemetry attributes discard additional sensitive fields", () => {
  const attributes = safeTelemetryAttributes({
    operationId: "op_safe_001",
    route: "/platform/v1/health",
    statusCode: 200,
    address: forbiddenCanaries[4]
  });
  assert.deepEqual(Object.keys(attributes).sort(), ["http.response.status_code", "http.route", "kavaroutes.operation_id"]);
});

test("Pino policy redacts sensitive fields and allowlists request serialization", async () => {
  let output = "";
  const destination = new Writable({ write(chunk, _encoding, callback) { output += chunk.toString(); callback(); } });
  const logger = pino(safePinoOptions, destination);
  logger.info({
    req: {
      id: "op_safe_001",
      method: "POST",
      url: `/platform/v1/health?secret=${forbiddenCanaries[3]}`,
      routeOptions: { url: "/platform/v1/health" },
      headers: { authorization: forbiddenCanaries[0], cookie: forbiddenCanaries[1] }
    },
    request: { body: forbiddenCanaries[2], query: forbiddenCanaries[3] },
    address: forbiddenCanaries[4],
    coordinates: forbiddenCanaries[5],
    identity: forbiddenCanaries[6],
    signature: forbiddenCanaries[7]
  }, "safe event");
  await new Promise((resolve) => destination.end(resolve));
  for (const canary of forbiddenCanaries) assert.ok(!output.includes(canary), canary);
  assert.ok(output.includes("/platform/v1/health"));
});
