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

function unionLiterals(schema: JsonObject): Set<string> {
  return new Set((Array.isArray(schema.anyOf) ? schema.anyOf : []).flatMap((item) => {
    const member = object(item);
    if (typeof member.const === "string") return [member.const];
    return Array.isArray(member.enum) ? member.enum.filter((value): value is string => typeof value === "string") : [];
  }));
}

function compareProperties(before: JsonObject, after: JsonObject, location: string, findings: CompatibilityFinding[]): void {
  const beforeProperties = object(before.properties);
  const afterProperties = object(after.properties);
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
}

function compareRequired(before: JsonObject, after: JsonObject, location: string, findings: CompatibilityFinding[]): void {
  const beforeProperties = object(before.properties);
  const beforeRequired = stringSet(before.required);
  for (const property of stringSet(after.required)) {
    if (!beforeRequired.has(property) && property in beforeProperties) findings.push({ kind: "BREAKING", location: `${location}.${property}`, reason: "existing property became required" });
  }
}

function compareNumericBounds(before: JsonObject, after: JsonObject, location: string, findings: CompatibilityFinding[]): void {
  for (const keyword of ["maximum", "maxLength", "maxItems"] as const) {
    if (typeof before[keyword] === "number" && typeof after[keyword] === "number" && after[keyword] < before[keyword]) findings.push({ kind: "BREAKING", location, reason: `${keyword} narrowed` });
  }
  for (const keyword of ["minimum", "minLength", "minItems"] as const) {
    if (typeof before[keyword] === "number" && typeof after[keyword] === "number" && after[keyword] > before[keyword]) findings.push({ kind: "BREAKING", location, reason: `${keyword} narrowed` });
  }
}

function compareClosedEnums(before: JsonObject, after: JsonObject, location: string, findings: CompatibilityFinding[]): void {
  const enumChanged = (beforeValues: Set<string>, afterValues: Set<string>): boolean => beforeValues.size > 0
    && (beforeValues.size !== afterValues.size || [...beforeValues].some((value) => !afterValues.has(value)));
  if (enumChanged(stringSet(before.enum), stringSet(after.enum))) findings.push({ kind: "BREAKING", location, reason: "closed enum changed" });
  if (enumChanged(unionLiterals(before), unionLiterals(after))) findings.push({ kind: "BREAKING", location, reason: "closed enum changed" });
}

function compareObjectClosure(before: JsonObject, after: JsonObject, location: string, findings: CompatibilityFinding[]): void {
  if (before.additionalProperties === false && after.additionalProperties !== false) findings.push({ kind: "BREAKING", location, reason: "closed object became open" });
}

function compareItems(before: JsonObject, after: JsonObject, location: string, findings: CompatibilityFinding[]): void {
  const beforeItems = object(before.items);
  const afterItems = object(after.items);
  if (Object.keys(beforeItems).length > 0 && Object.keys(afterItems).length > 0) compareSchema(beforeItems, afterItems, `${location}[]`, findings);
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
  compareProperties(before, after, location, findings);
  compareRequired(before, after, location, findings);
  compareNumericBounds(before, after, location, findings);
  compareClosedEnums(before, after, location, findings);
  compareObjectClosure(before, after, location, findings);
  compareItems(before, after, location, findings);
}
