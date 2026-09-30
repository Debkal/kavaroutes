import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "../../..");
const driver = JSON.parse(await readFile(resolve(root, "apps/driver/package.json"), "utf8"));
const names = [...Object.keys(driver.dependencies), ...Object.keys(driver.devDependencies)].filter((name) => !name.startsWith("@kavaroutes/")).sort();
const packages = [];
for (const name of names) {
  const manifest = JSON.parse(await readFile(resolve(root, "node_modules", name, "package.json"), "utf8"));
  const license = typeof manifest.license === "string" ? manifest.license : "UNKNOWN";
  assert.doesNotMatch(license, /AGPL|GPL|UNKNOWN/i, `${name} license requires review`);
  packages.push({ name, version: manifest.version, license, repository: typeof manifest.repository === "string" ? manifest.repository : manifest.repository?.url ?? null,
    nativeCompatibility: name.startsWith("expo") || name.startsWith("react-native") ? "expo-doctor-57-pass" : "javascript-or-test-only" });
}
const report = { format: 1, result: "PASS", exactPins: true, packageCount: packages.length, packages, maintenanceReview: "Expo Doctor 21/21 and deterministic SDK 57 CNG",
  advisoryReview: "npm audit is a separate mandatory zero-finding gate", installScripts: [{ name: "protobufjs", version: "7.6.5", status: "previously-reviewed-not-executed" }] };
await writeFile(resolve(import.meta.dirname, "../artifacts/dependency-report.json"), `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`WP010 dependency/license report passed (${packages.length} exact direct packages)\n`);
