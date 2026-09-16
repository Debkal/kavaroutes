import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { allSchemas, capabilities, classifyOpenApiChange, problemRegistry, purposes } from "../dist/index.js";
import { registeredApiDocument, registeredRoutes } from "./registered-routes.mjs";
import { operationRequirements } from "./route-requirements.mjs";

const root = resolve(fileURLToPath(new URL("../../../", import.meta.url)));
const readJson = async (path) => JSON.parse(await readFile(resolve(root, path), "utf8"));
const [source, catalog, openapi, baseline, matrix, projections, privacy] = await Promise.all([
  readJson("contracts/nemt-domain/catalog/command-event-catalog.json"),
  readJson("packages/api-contracts/artifacts/operation-catalog.json"),
  readJson("packages/api-contracts/artifacts/openapi.json"),
  readJson("packages/api-contracts/artifacts/openapi.baseline.json"),
  readJson("packages/api-contracts/artifacts/route-matrix.json"),
  readJson("packages/api-contracts/artifacts/projection-policy.json"),
  readJson("governance/privacy/catalog/policy-registry.json"),
]);

const commandIds = source.commands.map((command) => command.id).sort();
const mappedIds = catalog.commandMappings.map((mapping) => mapping.commandId).sort();
assert.equal(commandIds.length, 88);
assert.deepEqual(mappedIds, commandIds, "every WP003 command must be mapped exactly once");
assert.equal(new Set(mappedIds).size, 88);
for (const mapping of catalog.commandMappings) {
  for (const field of ["method", "path", "operationId", "capability", "purpose", "relationshipRule", "requestSchema", "successSchema", "implementationState"]) {
    assert.equal(typeof mapping[field], "string", `${mapping.commandId}.${field}`);
  }
  assert.equal(mapping.idempotencyRequired, true);
}

assert.equal(openapi.openapi, "3.1.2");
const operations = [];
for (const [path, pathItem] of Object.entries(openapi.paths)) {
  for (const method of ["get", "head", "post", "put", "patch", "delete"]) {
    if (pathItem[method]) operations.push({ method: method.toUpperCase(), path, operation: pathItem[method] });
  }
}
assert.ok(operations.length > 0, "the registered API surface must not be empty");
assert.equal(new Set(operations.map(({ operation }) => operation.operationId)).size, operations.length);
assert.equal(operations.some(({ method }) => ["PATCH", "DELETE"].includes(method)), false);
for (const { method, path, operation } of operations) {
  assert.ok(Array.isArray(operation.security) && operation.security.length > 0, `${method} ${path} security`);
  assert.ok(operation.responses["400"] && operation.responses["401"] && operation.responses["500"], `${method} ${path} core problems`);
  for (const [status, response] of Object.entries(operation.responses)) {
    assert.equal(typeof response.description, "string", `${method} ${path} ${status} description`);
    if (Number(status) >= 400) assert.ok(response.content?.["application/problem+json"], `${method} ${path} ${status} problem media type`);
  }
  const parameters = operation.parameters ?? [];
  assert.equal(parameters.some((parameter) => parameter.in === "header" && /^x-tenant|tenant-id$/i.test(parameter.name)), false);
  assert.equal(parameters.some((parameter) => parameter.in === "query" && /token|authorization|tenant|idempotency|etag/i.test(parameter.name)), false);
}
const matrixKeys = matrix.routes.map((route) => `${route.method} ${route.path} ${route.operationId}`).sort();
const openapiKeys = operations.map(({ method, path, operation }) => `${method} ${path} ${operation.operationId}`).sort();
const catalogKeys = catalog.liveOperations.map((route) => `${route.method} ${route.path} ${route.operationId}`).sort();
assert.deepEqual(matrixKeys, openapiKeys);
assert.deepEqual(catalogKeys, openapiKeys);
assert.equal(new Set(catalog.liveOperations.map((route) => route.operationId)).size, catalog.liveOperations.length, "catalog operation ids are unique");

// The committed artifacts must still agree with the surface the source actually
// registers, and every catalog entry's authorization must match the requirement
// the route source enforces, not a hand-maintained restatement of it.
const derivedRoutes = registeredRoutes(await registeredApiDocument());
assert.deepEqual(derivedRoutes.map((route) => `${route.method} ${route.path} ${route.operationId}`).sort(), openapiKeys,
  "openapi.json is current for the composed API surface");
const derivedRequirements = operationRequirements(root, derivedRoutes.map((route) => route.operationId));
const capabilityUnion = new Set(capabilities);
const purposeUnion = new Set(purposes);
for (const route of catalog.liveOperations) {
  const context = `liveOperation ${route.operationId}`;
  assert.equal(typeof route.capability, "string", `${context} capability`);
  assert.ok(capabilityUnion.has(route.capability), `${context} capability is a declared capability`);
  for (const alternative of route.capabilityAlternatives ?? []) assert.ok(capabilityUnion.has(alternative), `${context} capability alternative ${alternative}`);
  if (route.capabilityAlternatives) assert.ok(route.capabilityAlternatives.includes(route.capability), `${context} lists its own capability`);
  assert.equal(typeof route.purpose, "string", `${context} purpose`);
  assert.ok(purposeUnion.has(route.purpose), `${context} purpose is a declared purpose`);
  for (const alternative of route.purposeAlternatives ?? []) assert.ok(purposeUnion.has(alternative), `${context} purpose alternative ${alternative}`);
  assert.ok(["ROUTE_GUARD", "DELEGATED_SERVICE", "AUTHENTICATED_PRINCIPAL"].includes(route.authorization), `${context} authorization kind`);
  assert.match(route.source ?? "", /^packages\/api-contracts\/src\/[\w.-]+\.ts:\d+$/, `${context} source location`);
  assert.equal(route.implementationState, "REGISTERED", `${context} implementation state`);
  const requirement = derivedRequirements.get(route.operationId);
  assert.ok(requirement, `${context} is registered by the source`);
  assert.equal(route.capability, requirement.capability, `${context} capability matches source`);
  assert.deepEqual(route.capabilityAlternatives ?? [], requirement.capabilityAlternatives ?? [], `${context} capability alternatives match source`);
  assert.equal(route.purpose, requirement.purpose, `${context} purpose matches source`);
  assert.deepEqual(route.purposeAlternatives ?? [], requirement.purposeAlternatives ?? [], `${context} purpose alternatives match source`);
  assert.equal(route.authorization, requirement.authorization, `${context} authorization kind matches source`);
  assert.equal(route.source, requirement.source, `${context} source location matches source`);
}
for (const mapping of catalog.commandMappings.filter((entry) => entry.implementationState === "IMPLEMENTED_REPRESENTATIVE")) {
  assert.ok(openapiKeys.some((key) => key === `${mapping.method} ${mapping.path} ${mapping.operationId}`), `${mapping.commandId} representative route parity`);
}

const componentTitles = new Set(Object.values(openapi.components.schemas).map((schema) => schema.title));
const typeboxIds = new Set(allSchemas.map((schema) => schema.$id));
assert.deepEqual([...componentTitles].sort(), [...typeboxIds].sort(), "TypeBox/OpenAPI schema parity");
assert.deepEqual(Object.keys(problemRegistry).map(Number).sort((a, b) => a - b), [400,401,403,404,406,408,409,410,412,413,415,422,428,429,500,502,503,504]);

const schemaByTitle = Object.fromEntries(Object.values(openapi.components.schemas).map((schema) => [schema.title, schema]));
const privacyFields = new Map(privacy.fields.map((field) => [field.id, field]));
function collectPropertyNames(schema, names = new Set(), visited = new Set()) {
  if (!schema || typeof schema !== "object") return names;
  if (schema.$ref) {
    if (visited.has(schema.$ref)) return names;
    visited.add(schema.$ref);
    const key = schema.$ref.split("/").at(-1);
    return collectPropertyNames(openapi.components.schemas[key], names, visited);
  }
  for (const [name, child] of Object.entries(schema.properties ?? {})) { names.add(name); collectPropertyNames(child, names, visited); }
  collectPropertyNames(schema.items, names, visited);
  for (const child of schema.anyOf ?? []) collectPropertyNames(child, names, visited);
  return names;
}
for (const projection of projections.projections) {
  const schema = schemaByTitle[projection.schemaId];
  assert.ok(schema, `projection schema ${projection.schemaId}`);
  const names = collectPropertyNames(schema);
  for (const sensitive of projection.sensitiveFields) {
    const field = privacyFields.get(sensitive.policyField);
    assert.ok(field, `privacy field ${sensitive.policyField}`);
    assert.ok(field.roles.includes(projection.role), `${sensitive.policyField} role`);
    assert.ok(field.purposes.includes(projection.purpose), `${sensitive.policyField} purpose`);
    assert.ok(field.destinations.includes(projection.destination), `${sensitive.policyField} destination`);
  }
  for (const forbidden of projection.forbiddenProperties ?? []) assert.equal(names.has(forbidden), false, `${projection.schemaId} forbids ${forbidden}`);
}

/** `@fastify/swagger` names referenced components `def-N` in traversal order, so
 * adding an unrelated operation renumbers them: the same schema appears under a
 * different key in an older baseline. Compare the accepted baseline against the
 * current document by each schema's own title instead of that positional key, or
 * every added operation reports as a breaking schema change. */
function titleKeyedDocument(document) {
  const schemas = document.components?.schemas ?? {};
  const keys = Object.keys(schemas);
  const titles = keys.map((key) => schemas[key]?.title);
  assert.equal(new Set(titles).size, titles.length, "component schema titles are unique");
  const titleByKey = Object.fromEntries(keys.map((key) => [key, schemas[key]?.title ?? key]));
  const rewrite = (value) => {
    if (Array.isArray(value)) return value.map(rewrite);
    if (value === null || typeof value !== "object") return value;
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
      key,
      key === "$ref" && typeof entry === "string" && entry.startsWith("#/components/schemas/")
        ? `#/components/schemas/${titleByKey[entry.slice("#/components/schemas/".length)] ?? entry.slice("#/components/schemas/".length)}`
        : rewrite(entry),
    ]));
  };
  const components = { ...document.components, schemas: Object.fromEntries(keys.map((key) => [titleByKey[key], schemas[key]])) };
  return rewrite({ ...document, components });
}

const compatibility = classifyOpenApiChange(titleKeyedDocument(baseline), titleKeyedDocument(openapi));
assert.deepEqual(compatibility.breaking, [], "current OpenAPI must be compatible with the accepted WP007 baseline");
const report = {
  schemaVersion: "wp007.contract-lint.v1",
  commandMappings: mappedIds.length,
  registeredOperations: operations.length,
  schemas: componentTitles.size,
  projections: projections.projections.length,
  breakingChanges: compatibility.breaking.length,
};
await writeFile(resolve(root, "packages/api-contracts/artifacts/lint-report.json"), `${JSON.stringify(report, null, 2)}\n`);
console.log(`wp007 contract lint: ${report.commandMappings} commands, ${report.registeredOperations} operations, ${report.schemas} schemas, no breaking changes`);
