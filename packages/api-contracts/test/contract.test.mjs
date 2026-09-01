import assert from "node:assert/strict";
import test from "node:test";
import { classifyOpenApiChange, createCursorCodec, parseStrictJson, ProtocolError, requestFingerprint, strongEtag } from "../dist/index.js";
import baseline from "../artifacts/openapi.baseline.json" with { type: "json" };

test("strict JSON rejects duplicate keys, malformed values, and excessive depth", () => {
  assert.deepEqual(parseStrictJson('{"safe":true,"nested":[1,2]}'), { safe: true, nested: [1, 2] });
  for (const source of ['{"a":1,"a":2}', '{"a":NaN}', '{"a":', '{"a":1} trailing']) {
    assert.throws(() => parseStrictJson(source), ProtocolError);
  }
  assert.throws(() => parseStrictJson('[[[[1]]]]', 2), (error) => error instanceof ProtocolError && error.code === "JSON_DEPTH_EXCEEDED");
});

test("cursor tokens are signed, scoped, filter-bound, and expiring", () => {
  const codec = createCursorCodec("synthetic-cursor-secret-contract-tests-1234");
  const now = new Date("2026-08-24T12:00:00.000Z");
  const scope = { organizationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", principalId: "10000000-0000-4000-8000-000000000001",
    purpose: "RIDER_INTAKE", filters: { lifecycle: "DRAFT" }, sort: "tripId:asc", schemaVersion: "wp007.contract.v1", policyVersion: "privacy-synthetic-v1" };
  const token = codec.encode({ ...scope, tieBreaker: "11111111-1111-4111-8111-111111111111", asOf: now.toISOString(), expiresAt: "2026-08-24T12:15:00.000Z" });
  assert.equal(codec.decode(token, scope, now).tieBreaker, "11111111-1111-4111-8111-111111111111");
  assert.throws(() => codec.decode(`${token.slice(0, -1)}x`, scope, now), (error) => error instanceof ProtocolError && error.code === "CURSOR_INVALID");
  assert.throws(() => codec.decode(token, { ...scope, filters: { lifecycle: "CANCELLED" } }, now), (error) => error instanceof ProtocolError && error.code === "CURSOR_SCOPE_MISMATCH");
  assert.throws(() => codec.decode(token, scope, new Date("2026-08-24T12:16:00.000Z")), (error) => error instanceof ProtocolError && error.statusCode === 410);
});

test("fingerprints and strong tags are deterministic but projection-bound", () => {
  assert.equal(requestFingerprint({ b: 2, a: 1 }), requestFingerprint({ a: 1, b: 2 }));
  assert.notEqual(strongEtag("secret", "resource", 1, "driver"), strongEtag("secret", "resource", 1, "dispatcher"));
});

test("compatibility classifier catches route, required-field, enum, and constraint breaks", () => {
  const compatible = structuredClone(baseline);
  const dispatcher = Object.values(compatible.components.schemas).find((schema) => schema.title === "DispatcherTrip");
  dispatcher.properties.optionalNote = { type: "string" };
  assert.equal(classifyOpenApiChange(baseline, compatible).breaking.length, 0);

  const breaking = structuredClone(baseline);
  delete breaking.paths["/v1/me"];
  const target = Object.values(breaking.components.schemas).find((schema) => schema.title === "DispatcherTrip");
  target.properties.requiredCode = { type: "string" };
  target.required.push("requiredCode");
  target.properties.lifecycle.anyOf.push({ const: "NEW_STATE", type: "string" });
  const timezone = Object.values(breaking.components.schemas).find((schema) => schema.title === "IanaTimezone");
  timezone.maxLength = 16;
  const report = classifyOpenApiChange(baseline, breaking);
  assert.ok(report.breaking.some((finding) => finding.reason === "operation removed"));
  assert.ok(report.breaking.some((finding) => finding.reason === "required property added"));
  assert.ok(report.breaking.some((finding) => finding.reason === "closed enum changed"));
  assert.ok(report.breaking.some((finding) => finding.reason === "maxLength narrowed"));
});

test("schema compatibility branch precedence remains independently characterized", () => {
  const document = (schema) => ({ paths: {}, components: { schemas: { Contract: schema } } });
  const cases = [
    ["property removed", { type: "object", properties: { value: { type: "string" } } }, { type: "object", properties: {} }],
    ["existing property became required", { type: "object", properties: { value: { type: "string" } } }, { type: "object", properties: { value: { type: "string" } }, required: ["value"] }],
    ["maximum narrowed", { type: "number", maximum: 10 }, { type: "number", maximum: 9 }],
    ["minimum narrowed", { type: "number", minimum: 1 }, { type: "number", minimum: 2 }],
    ["closed enum changed", { type: "string", enum: ["A", "B"] }, { type: "string", enum: ["A"] }],
    ["closed object became open", { type: "object", additionalProperties: false }, { type: "object" }],
    ["maxItems narrowed", { type: "array", maxItems: 3, items: { type: "string", maxLength: 10 } }, { type: "array", maxItems: 2, items: { type: "string", maxLength: 9 } }],
  ];
  for (const [reason, before, after] of cases) {
    const report = classifyOpenApiChange(document(before), document(after));
    assert.ok(report.breaking.some((finding) => finding.reason === reason), reason);
  }
});
