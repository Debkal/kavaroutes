// Source-derived authorization requirements for the registered API surface.
//
// The operation catalog must state what each registered operation actually
// requires. That is read out of the route source instead of being maintained by
// hand: every `requireAccess(...)` call in `src` contributes the capability and
// purpose it enforces, keyed by the operation id it authorizes. Routes that
// delegate authorization to a service (browser-command recovery) or that only
// require an authenticated principal are declared explicitly below, and the
// generator fails loudly if a registered operation has no requirement at all.
import ts from "typescript";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

const relativeSource = (file) => `packages/api-contracts/src/${file}`;

function sourceFiles(root) {
  const directory = resolve(root, "packages/api-contracts/src");
  return readdirSync(directory)
    .filter((file) => file.endsWith(".ts") && !file.endsWith(".generated.ts"))
    .map((file) => ({ file, text: readFileSync(resolve(directory, file), "utf8") }))
    .map(({ file, text }) => ({ file, text, source: ts.createSourceFile(file, text, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS) }));
}

function walk(node, visit) {
  visit(node);
  ts.forEachChild(node, (child) => { walk(child, visit); });
}

function stringLiterals(node, found = []) {
  if (!node) return found;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) { if (!found.includes(node.text)) found.push(node.text); return found; }
  // A conditional's test is a predicate, not a value: `kind === "CREATE_TRIP" ? …`
  // contributes no capability or purpose.
  if (ts.isConditionalExpression(node)) {
    stringLiterals(node.whenTrue, found);
    stringLiterals(node.whenFalse, found);
    return found;
  }
  ts.forEachChild(node, (child) => { stringLiterals(child, found); });
  return found;
}

function enclosingScope(node) {
  let scope = node.parent;
  while (scope && !ts.isBlock(scope) && !ts.isSourceFile(scope) && !ts.isModuleBlock(scope)) scope = scope.parent;
  return scope;
}

/** A shorthand property (`{ capability }`) resolves to its local declaration. */
function shorthandValue(objectLiteral, name) {
  const scope = enclosingScope(objectLiteral);
  if (!scope) return undefined;
  let found;
  const search = (node) => {
    if (found) return;
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name && node.initializer
      && node.getStart() < objectLiteral.getStart()) { found = node.initializer; return; }
    ts.forEachChild(node, (child) => { search(child); });
  };
  for (const statement of scope.statements ?? []) search(statement);
  return found;
}

function property(objectLiteral, name) {
  if (!objectLiteral || !ts.isObjectLiteralExpression(objectLiteral)) return undefined;
  for (const entry of objectLiteral.properties) {
    if (ts.isPropertyAssignment(entry) && entry.name?.getText() === name) return entry.initializer;
    if (ts.isShorthandPropertyAssignment(entry) && entry.name.getText() === name) return shorthandValue(objectLiteral, name);
  }
  return undefined;
}

function lineOf(file, node) { return `${relativeSource(file)}:${node.getSourceFile().getLineAndCharacterOfPosition(node.getStart()).line + 1}`; }

/** capability/purpose plus every accepted alternative for one authorization entry. */
function requirementFrom(expression, context) {
  const capability = property(expression, "capability");
  const purpose = property(expression, "purpose");
  if (!capability || !purpose) throw new Error(`AUTHORIZATION_REQUIREMENT_INCOMPLETE:${context}`);
  const capabilities = stringLiterals(capability);
  const purposes = stringLiterals(purpose);
  if (capabilities.length === 0 || purposes.length === 0) throw new Error(`AUTHORIZATION_REQUIREMENT_DYNAMIC:${context}`);
  const primary = ts.isConditionalExpression(capability) && ts.isStringLiteral(capability.whenTrue) ? capability.whenTrue.text : capabilities[0];
  return { capability: primary, capabilityAlternatives: [...capabilities].sort(), purposes };
}

/** operationId -> enforced capability/purpose, read from `requireAccess` calls. */
export function routeGuardRequirements(root) {
  const entries = new Map();
  for (const { file, source } of sourceFiles(root)) {
    walk(source, (node) => {
      if (!ts.isCallExpression(node) || !ts.isIdentifier(node.expression) || node.expression.text !== "requireAccess") return;
      const [, , requirement, operation] = node.arguments;
      const context = `${relativeSource(file)}:${node.getSourceFile().getLineAndCharacterOfPosition(node.getStart()).line + 1}`;
      if (!requirement || !operation) throw new Error(`REQUIRE_ACCESS_ARGUMENTS_INCOMPLETE:${context}`);
      const { capability, capabilityAlternatives, purposes } = requirementFrom(requirement, context);
      const targets = [];
      if (ts.isStringLiteral(operation)) targets.push({ operationId: operation.text, capability, alternatives: capabilityAlternatives });
      else if (ts.isConditionalExpression(operation) && ts.isStringLiteral(operation.whenTrue) && ts.isStringLiteral(operation.whenFalse)) {
        const test = operation.condition.getText(source);
        const branches = [operation.whenTrue.text, operation.whenFalse.text];
        const conditional = ts.isConditionalExpression(requirement && property(requirement, "capability")) ? property(requirement, "capability") : undefined;
        const paired = conditional && conditional.condition.getText(source) === test;
        branches.forEach((operationId, index) => targets.push({
          operationId,
          capability: paired ? (index === 0 ? conditional.whenTrue.text : conditional.whenFalse.text) : capability,
          alternatives: paired ? [conditional.whenTrue.text, conditional.whenFalse.text].sort() : capabilityAlternatives,
        }));
      } else throw new Error(`REQUIRE_ACCESS_OPERATION_DYNAMIC:${context}`);
      for (const target of targets) {
        if (entries.has(target.operationId)) throw new Error(`REQUIRE_ACCESS_DUPLICATE:${target.operationId}`);
        entries.set(target.operationId, {
          operationId: target.operationId,
          capability: target.capability,
          purpose: purposes[0],
          ...(purposes.length > 1 ? { purposeAlternatives: [...purposes].sort() } : {}),
          ...(target.alternatives.length > 1 ? { capabilityAlternatives: target.alternatives } : {}),
          authorization: "ROUTE_GUARD",
          source: context,
        });
      }
    });
  }
  return entries;
}

/** operationId -> source location of the route registration that declares it. */
function registeredOperationSources(root) {
  const entries = new Map();
  for (const { file, source } of sourceFiles(root)) {
    walk(source, (node) => {
      if (!ts.isPropertyAssignment(node) || node.name?.getText() !== "operationId") return;
      for (const operationId of stringLiterals(node.initializer)) {
        const where = `${relativeSource(file)}:${node.getSourceFile().getLineAndCharacterOfPosition(node.getStart()).line + 1}`;
        if (!entries.has(operationId)) entries.set(operationId, where);
      }
    });
  }
  return entries;
}

/** Capabilities and purposes the browser-command recovery service enforces itself. */
export function browserCommandRequirement(root) {
  const file = "browser-recovery.ts";
  const text = readFileSync(resolve(root, "packages/api-contracts/src", file), "utf8");
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS);
  let capabilities;
  let requirement;
  walk(source, (node) => {
    if (ts.isVariableDeclaration(node) && node.name?.getText() === "permissions" && node.initializer && ts.isObjectLiteralExpression(node.initializer)) {
      capabilities = node.initializer.properties.filter((entry) => ts.isPropertyAssignment(entry)).flatMap((entry) => stringLiterals(entry.initializer));
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "authorize") {
      const candidate = node.arguments[2];
      if (property(candidate, "capability") && !ts.isStringLiteral(property(candidate, "capability"))) requirement = candidate;
    }
  });
  if (!capabilities || !requirement) throw new Error("BROWSER_COMMAND_REQUIREMENT_NOT_FOUND");
  return {
    capabilities: [...new Set(capabilities)].sort(),
    purposes: stringLiterals(property(requirement, "purpose")).sort(),
    source: `${relativeSource(file)}:${requirement.getSourceFile().getLineAndCharacterOfPosition(requirement.getStart()).line + 1}`,
  };
}

/** Requirements for registered operations that do not carry a `requireAccess` guard.
 *
 * Browser-command recovery authorizes on the reserved envelope kind inside the
 * service (`permissions` + `access()` in `browser-recovery.ts`), and `/v1/me`
 * returns the caller's own principal projection without a capability check. Both
 * are declared here with the source they come from, and `operationRequirements`
 * fails if a registered operation is in neither this table nor the guard index.
 */
function delegatedRequirements(root) {
  const sources = registeredOperationSources(root);
  const browserCommand = browserCommandRequirement(root);
  const browserCommandEntry = {
    capability: browserCommand.capabilities[0],
    capabilityAlternatives: browserCommand.capabilities,
    purpose: browserCommand.purposes[0],
    ...(browserCommand.purposes.length > 1 ? { purposeAlternatives: browserCommand.purposes } : {}),
    authorization: "DELEGATED_SERVICE",
    source: browserCommand.source,
  };
  return {
    getMe: {
      capability: "profile:read",
      purpose: "SUPPORT_DIAGNOSTICS",
      authorization: "AUTHENTICATED_PRINCIPAL",
      source: sources.get("getMe"),
    },
    getPendingBrowserCommand: { ...browserCommandEntry },
    prepareBrowserCommand: { ...browserCommandEntry },
    acknowledgeBrowserCommand: { ...browserCommandEntry },
    executeBrowserCommand: { ...browserCommandEntry },
  };
}

/** Authorization requirement for every registered operation, keyed by operation id. */
export function operationRequirements(root, registeredOperationIds) {
  const guards = routeGuardRequirements(root);
  const delegated = delegatedRequirements(root);
  const missing = registeredOperationIds.filter((operationId) => !guards.has(operationId) && !delegated[operationId]);
  if (missing.length > 0) throw new Error(`REGISTERED_OPERATION_WITHOUT_REQUIREMENT:${[...missing].sort().join(",")}`);
  const unguarded = registeredOperationIds.filter((operationId) => !guards.has(operationId)).sort();
  const declared = Object.keys(delegated).sort();
  if (unguarded.join(",") !== declared.join(",")) throw new Error(`DELEGATED_REQUIREMENT_SET_MISMATCH:${unguarded.join(",")}!=${declared.join(",")}`);
  for (const [operationId, entry] of Object.entries(delegated)) {
    if (guards.has(operationId)) throw new Error(`DELEGATED_REQUIREMENT_UNEXPECTED:${operationId}`);
    if (!entry.source) throw new Error(`DELEGATED_REQUIREMENT_SOURCE_MISSING:${operationId}`);
    if (!entry.capability) throw new Error(`DELEGATED_REQUIREMENT_CAPABILITY_MISSING:${operationId}`);
  }
  return new Map(registeredOperationIds.map((operationId) => [operationId, guards.get(operationId) ?? delegated[operationId]]));
}
