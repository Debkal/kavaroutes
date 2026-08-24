import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  canonicalJson,
  normalizeProfile,
  normalizeScenario,
  readJson,
  syntheticId,
  validateProfile,
  validateResult,
  validateScenario,
  validateTenantIds
} from "../lib/contracts.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const small = await readJson(join(root, "profiles", "small-pilot.json"));
const commercial = await readJson(join(root, "profiles", "commercial-platform.json"));
const normal = await readJson(join(root, "scenarios", "normal-service-day.json"));
const noisy = await readJson(join(root, "scenarios", "noisy-tenant.json"));
const resultTemplate = await readJson(join(root, "results", "result-template.json"));

test("stable IDs and canonical normalized profiles are byte-equivalent", () => {
  assert.equal(syntheticId(small.seed, "trip", 0, 42), syntheticId(small.seed, "trip", 0, 42));
  assert.equal(canonicalJson(normalizeProfile(small)), canonicalJson(normalizeProfile(structuredClone(small))));
});

test("normalized scenarios are byte-equivalent", () => {
  assert.equal(canonicalJson(normalizeScenario(normal, small)), canonicalJson(normalizeScenario(structuredClone(normal), structuredClone(small))));
});

test("negative profile counts are rejected", () => {
  const invalid = structuredClone(small);
  invalid.dimensions.activeVehicles.value = -1;
  assert.throws(() => validateProfile(invalid), /must not be negative/);
});

test("impossible profiles are rejected", () => {
  const invalid = structuredClone(small);
  invalid.dimensions.legs.value = 1;
  assert.throws(() => validateProfile(invalid), /cannot be less than trips/);
});

test("missing units are rejected", () => {
  const invalid = structuredClone(small);
  delete invalid.dimensions.apiRate.unit;
  assert.throws(() => validateProfile(invalid), /must be a non-empty string/);
});

test("duplicate tenant IDs are rejected", () => {
  assert.throws(() => validateTenantIds(["syn_tenant_duplicate", "syn_tenant_duplicate"]), /duplicate tenant ID/);
});

test("cross-tenant fixture references are rejected", () => {
  const invalid = structuredClone(noisy);
  invalid.fixtures.references[0].to = "protected-trip";
  assert.throws(() => validateScenario(invalid, commercial), /cross-tenant fixture reference/);
});

test("undocumented external-service assumptions are rejected", () => {
  const invalid = structuredClone(small);
  invalid.externalServices[0].documented = false;
  assert.throws(() => validateProfile(invalid), /must be true/);
});

test("PHI-shaped contract fields are rejected", () => {
  const invalid = structuredClone(normal);
  invalid.parameters.memberId = "synthetic-member";
  assert.throws(() => validateScenario(invalid, small), /PHI-/);
});

test("result template is provider-neutral and valid", () => {
  assert.equal(validateResult(resultTemplate), resultTemplate);
  assert.equal(resultTemplate.status, "not-run");
});

test("unordered latency percentiles are rejected", () => {
  const invalid = structuredClone(resultTemplate);
  invalid.metrics.latencyP50.value = 10;
  invalid.metrics.latencyP95.value = 5;
  invalid.metrics.latencyP99.value = 20;
  assert.throws(() => validateResult(invalid), /p50 <= p95 <= p99/);
});
