export interface CompatibilityFinding {
  readonly kind: "BREAKING" | "COMPATIBLE";
  readonly location: string;
  readonly reason: string;
}

export interface CompatibilityReport {
  readonly breaking: readonly CompatibilityFinding[];
  readonly compatible: readonly CompatibilityFinding[];
}

type JsonObject = Record<string, unknown>;

function object(value: unknown): JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as JsonObject : {};
}

function stringSet(value: unknown): Set<string> {
  return new Set(Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []);
}

function operations(document: JsonObject): Map<string, JsonObject> {
  const result = new Map<string, JsonObject>();
  for (const [path, pathItem] of Object.entries(object(document.paths))) {
    for (const method of ["get", "head", "post", "put", "patch", "delete"]) {
      const operation = object(object(pathItem)[method]);
      if (Object.keys(operation).length > 0) result.set(`${method.toUpperCase()} ${path}`, operation);
    }
  }
  return result;
}

export function classifyOpenApiChange(baseline: JsonObject, candidate: JsonObject): CompatibilityReport {
  const findings: CompatibilityFinding[] = [];
  const beforeOperations = operations(baseline);
  const afterOperations = operations(candidate);
  for (const [key, before] of beforeOperations) {
    const after = afterOperations.get(key);
    if (!after) {
      findings.push({ kind: "BREAKING", location: key, reason: "operation removed" });
      continue;
    }
    const beforeStatuses = new Set(Object.keys(object(before.responses)));
    const afterStatuses = new Set(Object.keys(object(after.responses)));
    for (const status of beforeStatuses) if (!afterStatuses.has(status)) findings.push({ kind: "BREAKING", location: `${key} response ${status}`, reason: "response status removed" });
    for (const status of afterStatuses) if (!beforeStatuses.has(status)) findings.push({ kind: "COMPATIBLE", location: `${key} response ${status}`, reason: "response status added" });
    if (JSON.stringify(before.security ?? []) !== JSON.stringify(after.security ?? [])) {
      findings.push({ kind: "BREAKING", location: key, reason: "security requirements changed" });
    }
  }
  for (const key of afterOperations.keys()) if (!beforeOperations.has(key)) findings.push({ kind: "COMPATIBLE", location: key, reason: "operation added" });

  const beforeSchemas = object(object(baseline.components).schemas);
  const afterSchemas = object(object(candidate.components).schemas);
  for (const [name, rawBefore] of Object.entries(beforeSchemas)) {
    const rawAfter = afterSchemas[name];
    if (!rawAfter) {
      findings.push({ kind: "BREAKING", location: `schema ${name}`, reason: "schema removed" });
      continue;
    }
    compareSchema(object(rawBefore), object(rawAfter), `schema ${name}`, findings);
  }
  for (const name of Object.keys(afterSchemas)) if (!(name in beforeSchemas)) findings.push({ kind: "COMPATIBLE", location: `schema ${name}`, reason: "schema added" });
  return Object.freeze({
    breaking: Object.freeze(findings.filter((finding) => finding.kind === "BREAKING")),
    compatible: Object.freeze(findings.filter((finding) => finding.kind === "COMPATIBLE")),
  });
}

function compareSchema(before: JsonObject, after: JsonObject, location: string, findings: CompatibilityFinding[]): void {
  const beforeProperties = object(before.properties);
  const afterProperties = object(after.properties);
  const beforeRequired = stringSet(before.required);
  const afterRequired = stringSet(after.required);
  for (const [property, schema] of Object.entries(beforeProperties)) {
    if (!(property in afterProperties)) {
      findings.push({ kind: "BREAKING", location: `${location}.${property}`, reason: "property removed" });
      continue;
    }
    compareSchema(object(schema), object(afterProperties[property]), `${location}.${property}`, findings);
  }
  for (const property of Object.keys(afterProperties)) {
    if (property in beforeProperties) continue;
    findings.push({
      kind: afterRequired.has(property) ? "BREAKING" : "COMPATIBLE",
      location: `${location}.${property}`,
      reason: afterRequired.has(property) ? "required property added" : "optional property added",
    });
  }
  for (const property of afterRequired) {
    if (!beforeRequired.has(property) && property in beforeProperties) findings.push({ kind: "BREAKING", location: `${location}.${property}`, reason: "existing property became required" });
  }
  const narrowerMaximums = ["maximum", "maxLength", "maxItems"] as const;
  for (const keyword of narrowerMaximums) {
    if (typeof before[keyword] === "number" && typeof after[keyword] === "number" && after[keyword] < before[keyword]) {
      findings.push({ kind: "BREAKING", location, reason: `${keyword} narrowed` });
    }
  }
  const narrowerMinimums = ["minimum", "minLength", "minItems"] as const;
  for (const keyword of narrowerMinimums) {
    if (typeof before[keyword] === "number" && typeof after[keyword] === "number" && after[keyword] > before[keyword]) {
      findings.push({ kind: "BREAKING", location, reason: `${keyword} narrowed` });
    }
  }
  const beforeEnum = stringSet(before.enum);
  const afterEnum = stringSet(after.enum);
  if (beforeEnum.size > 0 && (beforeEnum.size !== afterEnum.size || [...beforeEnum].some((value) => !afterEnum.has(value)))) {
    findings.push({ kind: "BREAKING", location, reason: "closed enum changed" });
  }
  const unionLiterals = (schema: JsonObject): Set<string> => new Set((Array.isArray(schema.anyOf) ? schema.anyOf : []).flatMap((item) => {
    const member = object(item);
    if (typeof member.const === "string") return [member.const];
    return Array.isArray(member.enum) ? member.enum.filter((value): value is string => typeof value === "string") : [];
  }));
  const beforeLiterals = unionLiterals(before);
  const afterLiterals = unionLiterals(after);
  if (beforeLiterals.size > 0 && (beforeLiterals.size !== afterLiterals.size || [...beforeLiterals].some((value) => !afterLiterals.has(value)))) {
    findings.push({ kind: "BREAKING", location, reason: "closed enum changed" });
  }
  if (before.additionalProperties === false && after.additionalProperties !== false) {
    findings.push({ kind: "BREAKING", location, reason: "closed object became open" });
  }
  const beforeItems = object(before.items);
  const afterItems = object(after.items);
  if (Object.keys(beforeItems).length > 0 && Object.keys(afterItems).length > 0) compareSchema(beforeItems, afterItems, `${location}[]`, findings);
}
