import assert from "node:assert/strict";
import { Writable } from "node:stream";
import test from "node:test";
import pino from "pino";
import { safeLogEvent, safePinoOptions } from "@kavaroutes/api-host/logging";
import { safeTelemetryAttributes } from "@kavaroutes/api-host/telemetry";
import { forbiddenCanaries } from "@kavaroutes/platform-test-support";
import { unsafeLoggingFindings } from "../scripts/check-safe-logging.mjs";

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

test("safe application log events discard identifiers, URLs, payloads, and credentials", () => {
  const event = safeLogEvent({ event: "provider.exchange", outcome: "failed", statusCode: 503, durationBucket: "lt1000ms",
    url: forbiddenCanaries[0], token: forbiddenCanaries[1], cursor: forbiddenCanaries[2], body: forbiddenCanaries[3],
    organizationId: forbiddenCanaries[4], coordinates: forbiddenCanaries[5], error: forbiddenCanaries[6] });
  assert.deepEqual(event, { event: "provider.exchange", outcome: "failed", statusCode: 503, durationBucket: "lt1000ms" });
  for (const canary of forbiddenCanaries) assert.equal(JSON.stringify(event).includes(canary), false);
  assert.throws(() => safeLogEvent({ event: "unsafe value", outcome: "failed" }), /SAFE_LOG_EVENT_INVALID/);
});

test("static logging policy rejects direct console, Pino, and Fastify logger bypasses", () => {
  const cases = [
    ["apps/example/src/a.ts", "console.error(secret)", "DIRECT_CONSOLE"],
    ["apps/example/src/a.ts", "process.stderr.write(secret)", "DIRECT_PROCESS_OUTPUT"],
    ["packages/example/src/a.ts", "request.log.info({ body })", "DIRECT_LOGGER"],
    ["apps/example/src/a.ts", 'import pino from "pino"', "DIRECT_PINO_IMPORT"],
  ];
  for (const [path, source, code] of cases) assert.deepEqual(unsafeLoggingFindings(path, source), [{ path, code }]);
  assert.deepEqual(unsafeLoggingFindings("apps/example/src/a.ts", "safeLogEvent({ event: 'ok', outcome: 'completed' })"), []);
});
