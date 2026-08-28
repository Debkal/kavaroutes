import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const root = path.resolve(process.argv[2] ?? ".");
const sourceRoots = ["apps", "packages"];
const sourceFiles = [];

async function walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (["dist", "node_modules"].includes(entry.name)) continue;
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) await walk(target);
    else if (/\.tsx?$/.test(entry.name)) sourceFiles.push(target);
  }
}

for (const candidate of sourceRoots) {
  await walk(path.join(root, candidate));
}

const violations = [];
const importPattern = /(?:import|export)\s+(?:type\s+)?(?:[^"']*?\s+from\s+)?["']([^"']+)["']/g;
for (const file of sourceFiles) {
  const relative = path.relative(root, file).replaceAll(path.sep, "/");
  const text = await readFile(file, "utf8");
  const imports = [...text.matchAll(importPattern)].map((match) => match[1]);
  if (relative.includes("/domain/")) {
    for (const specifier of imports) {
      if (specifier !== "@kavaroutes/shared-kernel" && !specifier.startsWith("node:") && !specifier.startsWith("./")) {
        violations.push(`${relative}: domain import ${specifier}`);
      }
    }
    if (/process\.env|Fastify|drizzle|PgBoss|WebSocket|opentelemetry|pino/i.test(text)) {
      violations.push(`${relative}: framework/platform leakage`);
    }
  }
  if (relative.includes("/application/")) {
    for (const specifier of imports) {
      const allowed = specifier === "@kavaroutes/shared-kernel" || specifier.startsWith("../domain/") || specifier.startsWith("node:");
      if (!allowed) violations.push(`${relative}: application import ${specifier}`);
    }
  }
  if (!relative.startsWith("apps/") && /process\.env/.test(text)) {
    violations.push(`${relative}: environment read outside composition host`);
  }
  if (relative.startsWith("apps/driver/") || relative.startsWith("packages/driver-core/")) {
    for (const specifier of imports) {
      if (/fastify|drizzle|pg-boss|postgres-persistence|durable-execution/.test(specifier)) violations.push(`${relative}: server-only Driver import ${specifier}`);
    }
    if (/AsyncStorage|redux-persist|@googlemaps|firebase|process\.env/.test(text)) violations.push(`${relative}: prohibited Driver platform dependency`);
  }
  if (relative.startsWith("apps/web/")) {
    for (const specifier of imports) {
      if (/fastify|drizzle|pg-boss|postgres-persistence|durable-execution|driver-core|react-native|@googlemaps/.test(specifier)) violations.push(`${relative}: server/native/provider import ${specifier}`);
    }
    if (relative.startsWith("apps/web/src/") && /localStorage|sessionStorage|indexedDB|serviceWorker|process\.env/.test(text)) violations.push(`${relative}: prohibited web persistence/environment access`);
  }
  if (/import\s*\(/.test(text) && !["apps/api-host/src/main.ts", "apps/worker-host/src/main.ts", "apps/web/src/router.tsx"].includes(relative)) {
    violations.push(`${relative}: unreviewed dynamic import`);
  }
}

for (const directory of await readdir(path.join(root, "packages"), { withFileTypes: true })) {
  if (!directory.isDirectory()) continue;
  assert.ok(!["common", "shared", "utils", "services"].includes(directory.name), `generic package prohibited: ${directory.name}`);
  const manifest = JSON.parse(await readFile(path.join(root, "packages", directory.name, "package.json"), "utf8"));
  if (!manifest.exports) violations.push(`packages/${directory.name}/package.json: missing explicit exports`);
}

assert.deepEqual(violations, [], violations.join("\n"));
console.log(`architecture boundary check passed (${sourceFiles.length} TypeScript files)`);
