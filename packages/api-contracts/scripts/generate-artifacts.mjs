import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createWp007Api } from "../dist/index.js";

const root = resolve(fileURLToPath(new URL("../../../", import.meta.url)));
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}

const app = await createWp007Api({ requestIdFactory: () => "req_wp007_generation", now: () => new Date("2026-08-24T12:00:00.000Z") });
await app.ready();
const rawDocument = app.swagger();
const tripDetail = rawDocument.paths["/v1/organizations/{organizationId}/trips/{tripId}"];
if (!tripDetail?.get) throw new Error("REGISTERED_TRIP_DETAIL_ROUTE_REQUIRED");
tripDetail.head = structuredClone(tripDetail.get);
tripDetail.head.operationId = "headTrip";
tripDetail.head.responses["200"] = {
  description: "Trip headers",
  headers: tripDetail.get.responses["200"].headers,
};
const document = canonical(rawDocument);
await app.close();
const serialized = `${JSON.stringify(document, null, 2)}\n`;
const openapiPath = resolve(root, "packages/api-contracts/artifacts/openapi.json");
await writeFile(openapiPath, serialized);
if (process.argv.includes("--accept-baseline")) {
  await writeFile(resolve(root, "packages/api-contracts/artifacts/openapi.baseline.json"), serialized);
}

const routes = [];
for (const [path, pathItem] of Object.entries(document.paths)) {
  for (const method of ["get", "head", "post", "put", "delete"]) {
    if (pathItem[method]) routes.push({ method: method.toUpperCase(), path, operationId: pathItem[method].operationId,
      statuses: Object.keys(pathItem[method].responses).sort(), security: pathItem[method].security ?? [] });
  }
}
routes.sort((a, b) => `${a.path}:${a.method}`.localeCompare(`${b.path}:${b.method}`));
await writeFile(resolve(root, "packages/api-contracts/artifacts/route-matrix.json"), `${JSON.stringify({ schemaVersion: "wp007.route-matrix.v1", routes }, null, 2)}\n`);

const schemas = document.components?.schemas ?? {};
const schemaNamesByRef = Object.fromEntries(Object.entries(schemas).map(([key, schema]) => [`#/components/schemas/${key}`, schema.title ?? key]));
const schemasByTitle = Object.fromEntries(Object.values(schemas).filter((schema) => typeof schema.title === "string").map((schema) => [schema.title, schema]));

function schemaToTs(schema, name = "Anonymous") {
  if (!schema) throw new Error(`OPENAPI_SCHEMA_MISSING:${name}`);
  if (schema.$ref) return schemaNamesByRef[schema.$ref] ?? schema.$ref.split("/").at(-1);
  if (schema.const !== undefined) return JSON.stringify(schema.const);
  if (schema.enum) return schema.enum.map((value) => JSON.stringify(value)).join(" | ");
  if (schema.anyOf) return schema.anyOf.map((item) => schemaToTs(item, name)).join(" | ");
  if (schema.type === "string") return "string";
  if (["integer", "number"].includes(schema.type)) return "number";
  if (schema.type === "boolean") return "boolean";
  if (schema.type === "null") return "null";
  if (schema.type === "array" && Array.isArray(schema.items)) return `readonly [${schema.items.map((item) => schemaToTs(item, name)).join(", ")}]`;
  if (schema.type === "array") return `ReadonlyArray<${schemaToTs(schema.items, name)}> `;
  if (schema.type === "object" || schema.properties) {
    const required = new Set(schema.required ?? []);
    return `{ ${Object.entries(schema.properties ?? {}).map(([key, value]) => `readonly ${key}${required.has(key) ? "" : "?"}: ${schemaToTs(value, key)}`).join("; ")} }`;
  }
  return "unknown";
}

const selected = Object.values(schemas).map((schema) => schema.title).filter((title) => typeof title === "string").sort();
const declarations = selected.map((name) => `export type ${name} = ${schemaToTs(schemasByTitle[name], name)};`).join("\n");
function client(platform) {
  return `// Generated from WP007 OpenAPI 3.1.2; do not edit.\nexport const generatedClientPlatform = ${JSON.stringify(platform)} as const;\n${declarations}\n\nexport interface FetchLike { (path: string, init?: { readonly method?: string; readonly headers?: Readonly<Record<string,string>>; readonly body?: string }): Promise<{ readonly status: number; json(): Promise<unknown> }>; }\nexport class GeneratedApiProblem extends Error { constructor(readonly status: number, readonly problem: unknown) { super(\`API_PROBLEM:\${status}\`); } }\nexport function decodeDispatcherTrip(value: unknown): DispatcherTrip {\n  if (typeof value !== "object" || value === null) throw new Error("INVALID_TRIP_RESPONSE");\n  const source = value as Record<string, unknown>;\n  if (typeof source.tripId !== "string" || typeof source.riderReference !== "string" || typeof source.version !== "number") throw new Error("INVALID_TRIP_RESPONSE");\n  return { tripId: source.tripId, riderReference: source.riderReference, serviceDate: String(source.serviceDate), serviceTimezone: String(source.serviceTimezone), resolvedServiceAt: String(source.resolvedServiceAt), lifecycle: source.lifecycle as DispatcherTrip["lifecycle"], version: source.version };\n}\nexport function decodeEffectiveDriverPolicy(value: unknown): EffectiveDriverPolicy {\n  if (typeof value !== "object" || value === null) throw new Error("INVALID_DRIVER_POLICY_RESPONSE");\n  const source = value as Record<string, unknown>; const tier = source.commercialTier; const relationship = source.workforceRelationship;\n  if (!(["SMALL_BUSINESS","ENTERPRISE"] as const).includes(tier as CommercialTier) || !(["OWNER_OPERATOR","EMPLOYEE","CONTRACTOR"] as const).includes(relationship as WorkforceRelationship) || typeof source.canonicalDigest !== "string" || !/^[a-f0-9]{64}$/.test(source.canonicalDigest)) throw new Error("INVALID_DRIVER_POLICY_RESPONSE");\n  const inspection = [source.preInspection, source.postInspection, source.startOdometer, source.endOdometer] as unknown[];\n  if (inspection.some((control) => typeof control !== "object" || control === null || !(["DISABLED","OPTIONAL","REQUIRED"] as const).includes((control as { mode?: unknown }).mode as InspectionControlMode))) throw new Error("INVALID_DRIVER_POLICY_RESPONSE");\n  if (typeof source.returnVerification !== "object" || source.returnVerification === null || !(["DISABLED","ADVISORY","REQUIRED_WITH_AUDITED_OVERRIDE"] as const).includes((source.returnVerification as { mode?: unknown }).mode as ReturnVerificationMode)) throw new Error("INVALID_DRIVER_POLICY_RESPONSE");\n  if (typeof source.routeChange !== "object" || source.routeChange === null || !(["AUTHORIZED_SELF_APPROVE","DISPATCH_APPROVAL_REQUIRED","DISABLED"] as const).includes((source.routeChange as { mode?: unknown }).mode as RouteChangeMode)) throw new Error("INVALID_DRIVER_POLICY_RESPONSE");\n  return source as unknown as EffectiveDriverPolicy;\n}\nexport function decodeDriverManifest(value: unknown): DriverManifest {\n  if (typeof value !== "object" || value === null) throw new Error("INVALID_DRIVER_MANIFEST_RESPONSE"); const source = value as Record<string, unknown>; const effectivePolicy = decodeEffectiveDriverPolicy(source.effectivePolicy);\n  if (typeof source.driverReference !== "string" || typeof source.version !== "number" || !Array.isArray(source.assignments) || source.effectivePolicyDigest !== effectivePolicy.canonicalDigest) throw new Error("INVALID_DRIVER_MANIFEST_RESPONSE");\n  return { ...source, effectivePolicy } as unknown as DriverManifest;\n}\nexport function createKavaRoutesClient(fetcher: FetchLike) { return Object.freeze({ async getTrip(path: string, authorization: string) { const response = await fetcher(path, { headers: { authorization } }); if (response.status !== 200) throw new Error("API_PROBLEM"); return decodeDispatcherTrip(await response.json()); }, async getDriverManifest(path: string, authorization: string) { const response = await fetcher(path, { headers: { authorization } }); if (response.status !== 200) throw new Error("API_PROBLEM"); return decodeDriverManifest(await response.json()); }, async postCommand(path: string, authorization: string, body: unknown, expectedTag: StrongEtag, idempotencyKey: IdempotencyKey) { const response = await fetcher(path, { method: "POST", headers: { authorization, "content-type": "application/json", "if-match": expectedTag, "idempotency-key": idempotencyKey }, body: JSON.stringify(body) }); const payload = await response.json(); if (response.status < 200 || response.status >= 300) throw new GeneratedApiProblem(response.status, payload); return payload; } }); }\n`;
}
await writeFile(resolve(root, "packages/api-contracts/clients/web.generated.ts"), client("web"));
await writeFile(resolve(root, "packages/api-contracts/clients/native.generated.ts"), client("react-native"));
await writeFile(resolve(root, "packages/api-contracts/src/client-web.generated.ts"), client("web"));
console.log(`wp007 openapi sha256 ${createHash("sha256").update(serialized).digest("hex")} (${routes.length} registered operations)`);
