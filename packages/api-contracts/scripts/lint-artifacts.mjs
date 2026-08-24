import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { allSchemas, classifyOpenApiChange, problemRegistry } from "../dist/index.js";

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
assert.equal(operations.length, 12);
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

const compatibility = classifyOpenApiChange(baseline, openapi);
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
