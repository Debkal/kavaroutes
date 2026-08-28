import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
const root = path.resolve(import.meta.dirname, "../../..");
const web = JSON.parse(await readFile(path.join(root, "apps/web/package.json"), "utf8"));
const lock = JSON.parse(await readFile(path.join(root, "package-lock.json"), "utf8"));
const names = [...Object.keys(web.dependencies), ...Object.keys(web.devDependencies)].sort();
const packages = [];
for (const name of names) {
  const localManifest = path.join(root, "apps/web/node_modules", name, "package.json");
  let manifest;
  try { manifest = JSON.parse(await readFile(localManifest, "utf8")); }
  catch { manifest = JSON.parse(await readFile(path.join(root, "node_modules", name, "package.json"), "utf8")); }
  const requested = web.dependencies[name] ?? web.devDependencies[name];
  assert.equal(requested, manifest.version, `${name} is not installed at its exact pin`);
  const license = typeof manifest.license === "string" ? manifest.license : "UNKNOWN";
  assert.doesNotMatch(license, /AGPL|GPL|UNKNOWN/i, `${name} license requires review`);
  packages.push({ name, version: manifest.version, license, repository: typeof manifest.repository === "string" ? manifest.repository : manifest.repository?.url ?? null });
}
const graph = Object.entries(lock.packages).filter(([location]) => location.startsWith("node_modules/"));
const installScripts = graph.filter(([, metadata]) => metadata.hasInstallScript === true).map(([location, metadata]) => ({ name: location.slice("node_modules/".length), version: metadata.version, execution: "blocked unless explicitly reviewed through npm allow-scripts" }));
const report = { schemaVersion: 1, generatedAt: new Date().toISOString(), result: "PASS", exactPins: true, directPackageCount: packages.length, repositoryResolvedPackageEntries: graph.length, packages, maintenance: "Review monthly, on security advisories, and before changing framework/browser baselines.", advisories: "npm audit is a separate mandatory gate", installScripts };
const artifacts = path.resolve(import.meta.dirname, "../artifacts");
await mkdir(artifacts, { recursive: true });
await writeFile(path.join(artifacts, "dependency-report.json"), `${JSON.stringify(report, null, 2)}\n`);
console.log(`WP011 dependency report passed (${packages.length} exact direct packages; ${graph.length} repository package entries)`);
