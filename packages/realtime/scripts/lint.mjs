import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { PROTOCOL_CATALOG, REALTIME_CLOSE_CODES, REALTIME_LIMITS, realtimeSchemas, safeRealtimeTelemetry } from "../dist/index.js";

const root = resolve(import.meta.dirname, "..");
const artifact = JSON.parse(await readFile(resolve(root, "artifacts/protocol-catalog.json"), "utf8"));
const openapi = JSON.parse(await readFile(resolve(root, "artifacts/openapi.local.json"), "utf8"));
assert.equal(artifact.catalog.protocol, "kavaroutes.realtime.v1");
assert.equal(artifact.catalog.privateProtocol, true);
assert.equal(artifact.catalog.ianaRegistered, false);
assert.deepEqual(artifact.catalog.clientFrames, ["subscription.subscribe", "subscription.unsubscribe", "subscription.ack"]);
assert.deepEqual(artifact.catalog.serverFrames, ["connection.ready", "change.batch", "subscription.live", "subscription.reset-required", "subscription.revoked", "server.draining", "protocol.error"]);
assert.deepEqual(artifact.catalog.limits, REALTIME_LIMITS);
assert.deepEqual(artifact.catalog.closeCodes, REALTIME_CLOSE_CODES);
assert.equal(Object.keys(artifact.schemas).length, realtimeSchemas.length);
const recovery = openapi.paths["/v1/organizations/{organizationId}/realtime-change-queries"]?.post;
assert.ok(recovery);
assert.equal(recovery.operationId, "queryRealtimeChanges");
assert.deepEqual(recovery.security, [{ syntheticTestPrincipal: [] }]);
const recoveryRequest = recovery.requestBody.content["application/json"].schema;
assert.equal(recoveryRequest.type, "object");
assert.equal(recoveryRequest.additionalProperties, false);
assert.deepEqual(recoveryRequest.required, ["purpose", "scope", "cursor"]);
assert.equal(recoveryRequest.properties.cursor.pattern, "^rtc1[.][A-Za-z0-9_-]{48,8192}$");
assert.equal((recovery.parameters ?? []).some((parameter) => parameter.in === "query" && /cursor/i.test(parameter.name)), false);
assert.equal(openapi["x-kavaroutes-private-realtime"].public, false);
for (const schema of realtimeSchemas) {
  assert.ok(schema.$id && artifact.schemas[schema.$id]);
  if (schema.type === "object") assert.equal(schema.additionalProperties, false, `${schema.$id} must be closed`);
}
const source = await Promise.all(["contracts.ts", "cursor.ts", "authorization.ts", "client.ts", "store.ts", "gateway.ts", "fanout.ts", "fastify.ts", "postgres.ts", "telemetry.ts"].map((name) => readFile(resolve(root, "src", name), "utf8")));
const joined = source.join("\n");
assert.doesNotMatch(joined, /redis|bullmq|pubsub|socket\.io|firebase|ably|pusher/i);
assert.doesNotMatch(JSON.stringify(PROTOCOL_CATALOG.clientFrames), /command|mutation|token|field|topic/i);
assert.throws(() => safeRealtimeTelemetry({ metric: "fanout", outcome: "success", tenantId: "prohibited" }));
const migration = await readFile(resolve(root, "../postgres-persistence/migrations/0008_realtime_streams_and_recovery.sql"), "utf8");
for (const token of ["CREATE TABLE realtime.stream", "CREATE TABLE realtime.projection", "CREATE TABLE realtime.change", "CREATE TABLE realtime.consumer_checkpoint", "ENABLE ROW LEVEL SECURITY", "FORCE ROW LEVEL SECURITY", "kavaroutes_realtime"]) assert.match(migration, new RegExp(token.replaceAll(".", "\\.")));
const report = { format: 1, protocol: PROTOCOL_CATALOG.protocol, schemas: realtimeSchemas.length, clientFrames: PROTOCOL_CATALOG.clientFrames.length,
  serverFrames: PROTOCOL_CATALOG.serverFrames.length, closeCodes: Object.keys(REALTIME_CLOSE_CODES).length, maximumInboundBytes: REALTIME_LIMITS.maximumInboundBytes,
  maximumOutboundBatchBytes: REALTIME_LIMITS.maximumOutboundBatchBytes, result: "PASS" };
await writeFile(resolve(root, "artifacts/lint-report.json"), `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`WP009 protocol/privacy/migration lint passed (${realtimeSchemas.length} schemas)\n`);
