import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

export const REQUIRED_DIMENSIONS = Object.freeze({
  tenants: "tenant",
  activeVehicles: "vehicle",
  driverSessions: "concurrent_session",
  webUsers: "concurrent_user",
  trips: "trip/service_day",
  legs: "leg/service_day",
  importRows: "row/burst",
  realtimeConnections: "connection",
  apiRate: "request/second",
  locationRate: "sample/second",
  retainedLocationSamples: "sample/service_day",
  outboundFanout: "delivery/second"
});

const RATE_DIMENSIONS = new Set(["importRows", "apiRate", "locationRate", "outboundFanout"]);
const ENTITY_KINDS = Object.freeze([
  "tenant", "user", "trip", "vehicle", "location_sample", "command", "event"
]);
const FORBIDDEN_KEYS = new Set([
  "address", "credential", "diagnosis", "memberId", "member_id", "patientName",
  "riderName", "secret", "token"
]);

function fail(path, message) {
  throw new Error(`${path}: ${message}`);
}

function assertObject(value, path) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(path, "must be an object");
}

function assertString(value, path) {
  if (typeof value !== "string" || value.trim() === "") fail(path, "must be a non-empty string");
}

function assertInteger(value, path, { positive = false } = {}) {
  if (!Number.isSafeInteger(value)) fail(path, "must be a safe integer");
  if (positive ? value <= 0 : value < 0) fail(path, positive ? "must be greater than zero" : "must not be negative");
}

function validateDuration(duration, path) {
  assertObject(duration, path);
  if (typeof duration.value !== "number" || !Number.isFinite(duration.value) || duration.value <= 0) {
    fail(`${path}.value`, "must be a finite number greater than zero");
  }
  if (!["second", "minute", "hour"].includes(duration.unit)) fail(`${path}.unit`, "must be second, minute, or hour");
}

function durationSeconds(duration) {
  return duration.value * { second: 1, minute: 60, hour: 3600 }[duration.unit];
}

function validateQuantity(quantity, path, expectedUnit) {
  assertObject(quantity, path);
  assertInteger(quantity.value, `${path}.value`);
  assertString(quantity.unit, `${path}.unit`);
  if (quantity.unit !== expectedUnit) fail(`${path}.unit`, `must be ${expectedUnit}`);
}

function validateExternalAssumptions(items, path) {
  if (!Array.isArray(items) || items.length === 0) fail(path, "must document at least one external-service assumption");
  const names = new Set();
  for (const [index, item] of items.entries()) {
    const itemPath = `${path}[${index}]`;
    assertObject(item, itemPath);
    assertString(item.name, `${itemPath}.name`);
    assertString(item.mode, `${itemPath}.mode`);
    assertString(item.assumption, `${itemPath}.assumption`);
    if (item.documented !== true) fail(`${itemPath}.documented`, "must be true");
    if (names.has(item.name)) fail(itemPath, `duplicate external service ${item.name}`);
    names.add(item.name);
  }
}

function scanForSensitiveData(value, path = "contract") {
  if (Array.isArray(value)) {
    value.forEach((item, index) => scanForSensitiveData(item, `${path}[${index}]`));
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      if (FORBIDDEN_KEYS.has(key)) fail(`${path}.${key}`, "PHI-, credential-, or secret-bearing fields are forbidden");
      scanForSensitiveData(child, `${path}.${key}`);
    }
    return;
  }
  if (typeof value === "string") {
    if (/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i.test(value)) fail(path, "email-shaped synthetic data is forbidden");
    if (/\b(?:sk-[A-Za-z0-9]{16,}|AIza[A-Za-z0-9_-]{20,})\b/.test(value)) fail(path, "secret-shaped synthetic data is forbidden");
  }
}

export function validateTenantIds(tenantIds, path = "tenantIds") {
  if (!Array.isArray(tenantIds) || tenantIds.length === 0) fail(path, "must be a non-empty array");
  const unique = new Set();
  for (const [index, tenantId] of tenantIds.entries()) {
    assertString(tenantId, `${path}[${index}]`);
    if (unique.has(tenantId)) fail(`${path}[${index}]`, `duplicate tenant ID ${tenantId}`);
    unique.add(tenantId);
  }
}

export function canonicalJson(value) {
  const sort = (item) => {
    if (Array.isArray(item)) return item.map(sort);
    if (item !== null && typeof item === "object") {
      return Object.fromEntries(Object.keys(item).sort().map((key) => [key, sort(item[key])]));
    }
    return item;
  };
  return `${JSON.stringify(sort(value), null, 2)}\n`;
}

export function digest(value) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function syntheticId(seed, kind, tenantOrdinal, entityOrdinal) {
  assertString(seed, "seed");
  if (!ENTITY_KINDS.includes(kind)) fail("kind", `unsupported entity kind ${kind}`);
  assertInteger(tenantOrdinal, "tenantOrdinal");
  assertInteger(entityOrdinal, "entityOrdinal");
  const hash = createHash("sha256")
    .update(`${seed}|${kind}|${tenantOrdinal}|${entityOrdinal}`)
    .digest("hex").slice(0, 20);
  return `syn_${kind}_${hash}`;
}

function distribute(total, tenantCount) {
  const base = Math.floor(total / tenantCount);
  const remainder = total % tenantCount;
  return Array.from({ length: tenantCount }, (_, index) => base + (index < remainder ? 1 : 0));
}

function entityPopulations(profile) {
  const d = profile.dimensions;
  const commands = d.legs.value * 4;
  return {
    tenant: { total: d.tenants.value, formula: "dimensions.tenants" },
    user: { total: d.driverSessions.value + d.webUsers.value, formula: "dimensions.driverSessions + dimensions.webUsers" },
    trip: { total: d.trips.value, formula: "dimensions.trips" },
    vehicle: { total: d.activeVehicles.value, formula: "dimensions.activeVehicles" },
    location_sample: { total: d.retainedLocationSamples.value, formula: "dimensions.retainedLocationSamples" },
    command: { total: commands, formula: "dimensions.legs * 4" },
    event: { total: commands * 2, formula: "commands * 2" }
  };
}

export function validateProfile(profile) {
  assertObject(profile, "profile");
  if (profile.schemaVersion !== "1.0.0") fail("profile.schemaVersion", "must be 1.0.0");
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(profile.id ?? "")) fail("profile.id", "must be kebab-case");
  assertString(profile.name, "profile.name");
  assertString(profile.seed, "profile.seed");
  if (profile.approval !== "provisional") fail("profile.approval", "must remain provisional until human approval");
  validateDuration(profile.serviceWindow, "profile.serviceWindow");

  assertObject(profile.adaptiveSampling, "profile.adaptiveSampling");
  for (const key of ["moving", "enRoute", "stationary", "retainedAverage"]) {
    validateQuantity(profile.adaptiveSampling[key], `profile.adaptiveSampling.${key}`, "second/sample");
    if (profile.adaptiveSampling[key].value === 0) fail(`profile.adaptiveSampling.${key}.value`, "must be greater than zero");
  }
  const sampling = profile.adaptiveSampling;
  if (!(sampling.moving.value <= sampling.enRoute.value && sampling.enRoute.value <= sampling.stationary.value)) {
    fail("profile.adaptiveSampling", "must back off from moving to en-route to stationary");
  }

  assertObject(profile.dimensions, "profile.dimensions");
  for (const [key, unit] of Object.entries(REQUIRED_DIMENSIONS)) {
    validateQuantity(profile.dimensions[key], `profile.dimensions.${key}`, unit);
    if (RATE_DIMENSIONS.has(key)) validateDuration(profile.dimensions[key].peakDuration, `profile.dimensions.${key}.peakDuration`);
  }
  const d = profile.dimensions;
  if (d.tenants.value === 0) fail("profile.dimensions.tenants.value", "must be greater than zero");
  if (d.trips.value > 0 && d.activeVehicles.value === 0) fail("profile.dimensions.activeVehicles.value", "cannot be zero when trips are present");
  if (d.trips.value > 0 && d.driverSessions.value === 0) fail("profile.dimensions.driverSessions.value", "cannot be zero when trips are present");
  if (d.legs.value < d.trips.value) fail("profile.dimensions.legs.value", "cannot be less than trips");
  if (d.realtimeConnections.value < d.driverSessions.value) fail("profile.dimensions.realtimeConnections.value", "cannot be less than concurrent driver sessions");

  if (!Array.isArray(profile.tenantGroups) || profile.tenantGroups.length === 0) fail("profile.tenantGroups", "must be a non-empty array");
  const groupIds = new Set();
  let tenantTotal = 0;
  for (const [index, group] of profile.tenantGroups.entries()) {
    const path = `profile.tenantGroups[${index}]`;
    assertObject(group, path);
    assertString(group.id, `${path}.id`);
    assertInteger(group.count, `${path}.count`, { positive: true });
    if (groupIds.has(group.id)) fail(`${path}.id`, `duplicate group ID ${group.id}`);
    groupIds.add(group.id);
    tenantTotal += group.count;
  }
  if (tenantTotal !== d.tenants.value) fail("profile.tenantGroups", "group counts must equal dimensions.tenants");

  const expectedRetained = Math.round(d.activeVehicles.value * durationSeconds(profile.serviceWindow) / sampling.retainedAverage.value);
  if (d.retainedLocationSamples.value !== expectedRetained) {
    fail("profile.dimensions.retainedLocationSamples.value", `must equal activeVehicles * serviceWindowSeconds / retainedAverageSeconds (${expectedRetained})`);
  }

  if (!Array.isArray(profile.derivedValues) || profile.derivedValues.length === 0) fail("profile.derivedValues", "must document derived formulas");
  for (const [index, derived] of profile.derivedValues.entries()) {
    assertObject(derived, `profile.derivedValues[${index}]`);
    assertString(derived.field, `profile.derivedValues[${index}].field`);
    assertString(derived.formula, `profile.derivedValues[${index}].formula`);
    if (!Array.isArray(derived.inputs) || derived.inputs.length === 0) fail(`profile.derivedValues[${index}].inputs`, "must list source fields");
  }
  validateExternalAssumptions(profile.externalServices, "profile.externalServices");
  scanForSensitiveData(profile, "profile");
  return profile;
}

export function normalizeProfile(profile) {
  validateProfile(profile);
  const tenantCount = profile.dimensions.tenants.value;
  const tenantIds = Array.from({ length: tenantCount }, (_, tenantOrdinal) => syntheticId(profile.seed, "tenant", tenantOrdinal, 0));
  validateTenantIds(tenantIds);
  const populations = entityPopulations(profile);
  const sampleIds = {};
  for (const kind of ENTITY_KINDS) {
    if (kind === "tenant") {
      sampleIds[kind] = [tenantIds[0], tenantIds.at(-1)];
      continue;
    }
    const counts = distribute(populations[kind].total, tenantCount);
    const firstTenant = counts.findIndex((count) => count > 0);
    let lastTenant = counts.length - 1;
    while (lastTenant >= 0 && counts[lastTenant] === 0) lastTenant -= 1;
    sampleIds[kind] = [
      syntheticId(profile.seed, kind, firstTenant, 0),
      syntheticId(profile.seed, kind, lastTenant, counts[lastTenant] - 1)
    ];
  }
  const normalized = {
    contractType: "kavaroutes.synthetic-workload-profile",
    schemaVersion: profile.schemaVersion,
    profileId: profile.id,
    approval: profile.approval,
    seed: profile.seed,
    source: profile,
    identityContract: {
      algorithm: "sha256(seed|kind|tenantOrdinal|entityOrdinal), first 20 hex characters",
      supportedKinds: ENTITY_KINDS,
      tenantIds,
      sampleIds
    },
    entityPopulations: populations,
    distribution: {
      rule: "integer quotient across tenants; remainder assigned by ascending tenant ordinal",
      countsByKind: Object.fromEntries(Object.entries(populations).map(([kind, value]) => [kind, distribute(value.total, tenantCount)]))
    }
  };
  return { ...normalized, digest: digest(normalized) };
}

export function validateScenario(scenario, profile) {
  validateProfile(profile);
  assertObject(scenario, "scenario");
  if (scenario.schemaVersion !== "1.0.0") fail("scenario.schemaVersion", "must be 1.0.0");
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(scenario.id ?? "")) fail("scenario.id", "must be kebab-case");
  assertString(scenario.name, "scenario.name");
  assertString(scenario.seed, "scenario.seed");
  if (!Array.isArray(scenario.profileIds) || scenario.profileIds.length === 0) fail("scenario.profileIds", "must list compatible profiles or *");
  if (!scenario.profileIds.includes("*") && !scenario.profileIds.includes(profile.id)) fail("scenario.profileIds", `does not include profile ${profile.id}`);
  validateDuration(scenario.duration, "scenario.duration");
  if (!Array.isArray(scenario.phases) || scenario.phases.length === 0) fail("scenario.phases", "must be a non-empty array");
  let phaseSeconds = 0;
  const phaseIds = new Set();
  for (const [index, phase] of scenario.phases.entries()) {
    const path = `scenario.phases[${index}]`;
    assertObject(phase, path);
    assertString(phase.id, `${path}.id`);
    if (phaseIds.has(phase.id)) fail(`${path}.id`, `duplicate phase ${phase.id}`);
    phaseIds.add(phase.id);
    validateDuration(phase.duration, `${path}.duration`);
    phaseSeconds += durationSeconds(phase.duration);
    assertObject(phase.loadMultipliers, `${path}.loadMultipliers`);
    for (const [dimension, multiplier] of Object.entries(phase.loadMultipliers)) {
      if (!(dimension in REQUIRED_DIMENSIONS)) fail(`${path}.loadMultipliers.${dimension}`, "unknown dimension");
      if (typeof multiplier !== "number" || !Number.isFinite(multiplier) || multiplier < 0) fail(`${path}.loadMultipliers.${dimension}`, "must be a non-negative finite number");
    }
  }
  if (phaseSeconds !== durationSeconds(scenario.duration)) fail("scenario.phases", "phase durations must exactly equal scenario duration");

  assertObject(scenario.fixtures, "scenario.fixtures");
  if (!Array.isArray(scenario.fixtures.actors) || scenario.fixtures.actors.length === 0) fail("scenario.fixtures.actors", "must be a non-empty array");
  const tenantCount = profile.dimensions.tenants.value;
  const populations = entityPopulations(profile);
  const actorMap = new Map();
  for (const [index, actor] of scenario.fixtures.actors.entries()) {
    const path = `scenario.fixtures.actors[${index}]`;
    assertObject(actor, path);
    assertString(actor.key, `${path}.key`);
    if (actorMap.has(actor.key)) fail(`${path}.key`, `duplicate actor key ${actor.key}`);
    if (!ENTITY_KINDS.includes(actor.kind)) fail(`${path}.kind`, `unsupported kind ${actor.kind}`);
    assertInteger(actor.tenantOrdinal, `${path}.tenantOrdinal`);
    assertInteger(actor.entityOrdinal, `${path}.entityOrdinal`);
    if (actor.tenantOrdinal >= tenantCount) fail(`${path}.tenantOrdinal`, "outside profile tenant range");
    const localCount = actor.kind === "tenant" ? 1 : distribute(populations[actor.kind].total, tenantCount)[actor.tenantOrdinal];
    if (actor.entityOrdinal >= localCount) fail(`${path}.entityOrdinal`, "outside entity population");
    actorMap.set(actor.key, actor);
  }
  if (!Array.isArray(scenario.fixtures.references)) fail("scenario.fixtures.references", "must be an array");
  for (const [index, reference] of scenario.fixtures.references.entries()) {
    const path = `scenario.fixtures.references[${index}]`;
    assertObject(reference, path);
    assertString(reference.from, `${path}.from`);
    assertString(reference.to, `${path}.to`);
    assertInteger(reference.tenantOrdinal, `${path}.tenantOrdinal`);
    const from = actorMap.get(reference.from);
    const to = actorMap.get(reference.to);
    if (!from || !to) fail(path, "must reference declared actors");
    if (from.tenantOrdinal !== reference.tenantOrdinal || to.tenantOrdinal !== reference.tenantOrdinal) fail(path, "cross-tenant fixture reference is forbidden");
  }
  validateExternalAssumptions(scenario.externalServices, "scenario.externalServices");
  scanForSensitiveData(scenario, "scenario");
  return scenario;
}

export function normalizeScenario(scenario, profile) {
  validateScenario(scenario, profile);
  const combinedSeed = `${profile.seed}|${scenario.seed}`;
  const actors = scenario.fixtures.actors.map((actor) => ({
    ...actor,
    seed: combinedSeed,
    generatedId: syntheticId(combinedSeed, actor.kind, actor.tenantOrdinal, actor.entityOrdinal)
  }));
  const actorMap = new Map(actors.map((actor) => [actor.key, actor]));
  const references = scenario.fixtures.references.map((reference) => ({
    ...reference,
    fromId: actorMap.get(reference.from).generatedId,
    toId: actorMap.get(reference.to).generatedId
  }));
  const normalized = {
    contractType: "kavaroutes.synthetic-workload-scenario",
    schemaVersion: scenario.schemaVersion,
    scenarioId: scenario.id,
    profileId: profile.id,
    seed: combinedSeed,
    source: scenario,
    fixtures: { actors, references }
  };
  return { ...normalized, digest: digest(normalized) };
}

export function validateResult(result) {
  assertObject(result, "result");
  if (result.schemaVersion !== "1.0.0") fail("result.schemaVersion", "must be 1.0.0");
  if (!["not-run", "completed", "failed"].includes(result.status)) fail("result.status", "must be not-run, completed, or failed");
  for (const key of ["profileId", "scenarioId", "datasetDigest", "environment", "implementationVersion"]) assertString(result[key], `result.${key}`);
  validateDuration(result.duration, "result.duration");
  assertObject(result.metrics, "result.metrics");
  const required = ["throughput", "latencyP50", "latencyP95", "latencyP99", "errorRate", "rejectedSamples", "duplicates", "lostAcknowledgements", "cursorRecoveryTime", "tenantIsolationFailures"];
  for (const key of required) {
    const metric = result.metrics[key];
    assertObject(metric, `result.metrics.${key}`);
    if (metric.value !== null && (typeof metric.value !== "number" || !Number.isFinite(metric.value) || metric.value < 0)) fail(`result.metrics.${key}.value`, "must be null or a non-negative finite number");
    assertString(metric.unit, `result.metrics.${key}.unit`);
  }
  const latency = ["latencyP50", "latencyP95", "latencyP99"].map((key) => result.metrics[key].value);
  if (latency.every((value) => value !== null) && !(latency[0] <= latency[1] && latency[1] <= latency[2])) fail("result.metrics", "latency percentiles must be ordered p50 <= p95 <= p99");
  if (!Array.isArray(result.estimatedUnitCosts)) fail("result.estimatedUnitCosts", "must be an array");
  for (const [index, cost] of result.estimatedUnitCosts.entries()) {
    assertObject(cost, `result.estimatedUnitCosts[${index}]`);
    assertString(cost.name, `result.estimatedUnitCosts[${index}].name`);
    if (cost.value !== null && (typeof cost.value !== "number" || !Number.isFinite(cost.value) || cost.value < 0)) fail(`result.estimatedUnitCosts[${index}].value`, "must be null or non-negative");
    assertString(cost.currency, `result.estimatedUnitCosts[${index}].currency`);
    assertString(cost.unit, `result.estimatedUnitCosts[${index}].unit`);
  }
  scanForSensitiveData(result, "result");
  return result;
}

export async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

export async function readJsonDirectory(path) {
  const names = (await readdir(path)).filter((name) => name.endsWith(".json")).sort();
  return Promise.all(names.map((name) => readJson(join(path, name))));
}
