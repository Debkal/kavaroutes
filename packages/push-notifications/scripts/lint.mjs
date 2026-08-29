import assert from "node:assert/strict";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, ".."); const files = [];
async function walk(directory) { for (const entry of await readdir(directory, { withFileTypes: true })) { const target = resolve(directory, entry.name); if (entry.isDirectory()) await walk(target); else if (entry.name.endsWith(".ts")) files.push(target); } }
await walk(resolve(root, "src")); const source = (await Promise.all(files.map((file) => readFile(file, "utf8")))).join("\n");
assert.doesNotMatch(source, /expo-server-sdk|legacy server key|firebase-admin|notifications composer|bigquery|firestore|remote config|serviceWorker/i);
assert.doesNotMatch(source, /process\.env|console\.(?:log|error)|Authorization:\s*Bearer|-----BEGIN PRIVATE KEY-----\n[A-Za-z0-9+/]{16}/i);
const report = { format: 1, result: "PASS", sourceFiles: files.length, providerNetworkConfigured: false, policyVersion: "push.policy.v1", kinds: 3 };
await writeFile(resolve(root, "artifacts/local-lint-report.json"), `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`WP012 notification privacy lint passed (${files.length} source files; providers disabled)\n`);
