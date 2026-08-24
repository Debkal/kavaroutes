import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createApi } from "@kavaroutes/api-host";

const operationId = "op_api_test_001";

test("Fastify factory serves only the versioned synthetic platform surface without listening", async (t) => {
  const app = await createApi({ operationIdFactory: () => operationId });
  t.after(() => app.close());

  const health = await app.inject({ method: "GET", url: "/platform/v1/health" });
  assert.equal(health.statusCode, 200);
  assert.deepEqual(health.json(), { status: "ok", version: "wp005.synthetic.v1" });

  const readiness = await app.inject({ method: "GET", url: "/platform/v1/readiness" });
  assert.equal(readiness.statusCode, 200);
  assert.deepEqual(readiness.json(), { status: "ready", checks: { engine: true } });

  const absentBusinessApi = await app.inject({ method: "GET", url: "/v1/trips" });
  assert.equal(absentBusinessApi.statusCode, 404);
});

test("synthetic probe validates, serializes, and rejects unknown properties", async (t) => {
  const app = await createApi({ operationIdFactory: () => operationId });
  t.after(() => app.close());

  const accepted = await app.inject({
    method: "POST",
    url: "/platform/v1/synthetic-probe",
    headers: { "content-type": "application/json" },
    payload: { probeId: "probe_1234abcd", input: "alpha", idempotencyKey: "idem_safe_001" }
  });
  assert.equal(accepted.statusCode, 202);
  assert.deepEqual(accepted.json(), {
    probeId: "probe_1234abcd",
    outcome: "accepted",
    jobId: "job_idem_safe_001",
    operationId
  });

  const rejected = await app.inject({
    method: "POST",
    url: "/platform/v1/synthetic-probe?private=CANARY_QUERY_PRIVATE_94",
    headers: { authorization: "CANARY_AUTH_SECRET_91" },
    payload: {
      probeId: "probe_1234abcd",
      input: "alpha",
      idempotencyKey: "idem_safe_001",
      privateValue: "CANARY_BODY_PRIVATE_93"
    }
  });
  assert.equal(rejected.statusCode, 400);
  assert.deepEqual(rejected.json(), { code: "VALIDATION_FAILED", operationId });
  assert.ok(!rejected.body.includes("CANARY"));

  const prototypeOriented = await app.inject({
    method: "POST",
    url: "/platform/v1/synthetic-probe",
    headers: { "content-type": "application/json" },
    payload: '{"probeId":"probe_1234abcd","input":"alpha","idempotencyKey":"idem_safe_001","__proto__":{"polluted":true}}'
  });
  assert.equal(prototypeOriented.statusCode, 400);
  assert.equal({}.polluted, undefined);
});

test("malformed and oversized payloads produce safe bounded errors", async (t) => {
  const app = await createApi({ operationIdFactory: () => operationId });
  t.after(() => app.close());
  const malformed = await app.inject({
    method: "POST",
    url: "/platform/v1/synthetic-probe",
    headers: { "content-type": "application/json" },
    payload: "{broken"
  });
  assert.equal(malformed.statusCode, 400);
  assert.ok(!malformed.body.includes("broken"));

  const oversized = await app.inject({
    method: "POST",
    url: "/platform/v1/synthetic-probe",
    payload: { filler: "x".repeat(17 * 1024) }
  });
  assert.equal(oversized.statusCode, 413);
  assert.ok(oversized.body.length < 256);
});

test("OpenAPI artifact is complete and deterministic", async () => {
  const first = await readFile(new URL("../artifacts/openapi/wp005.openapi.json", import.meta.url), "utf8");
  const app = await createApi({ operationIdFactory: () => operationId });
  await app.ready();
  const paths = app.swagger().paths;
  assert.deepEqual(Object.keys(paths).sort(), [
    "/platform/v1/health",
    "/platform/v1/readiness",
    "/platform/v1/synthetic-probe"
  ]);
  for (const operations of Object.values(paths)) {
    for (const operation of Object.values(operations)) {
      assert.ok(operation.responses, "every documented operation must declare responses");
    }
  }
  assert.deepEqual(app.swagger()["x-kavaroutes-websocket-routes"], [{
    path: "/platform/v1/socket-probe",
    purpose: "synthetic lifecycle compatibility only",
    contextHeader: "x-synthetic-context",
    maxPayloadBytes: 1024,
    messageSchema: "SocketNotification"
  }]);
  await app.close();
  const second = await readFile(new URL("../artifacts/openapi/wp005.openapi.json", import.meta.url), "utf8");
  assert.equal(first, second);
  assert.ok(!first.includes("CANARY_"));
});
