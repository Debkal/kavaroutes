import {execFileSync} from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const lockText = readFileSync(join(root, "package-lock.json"), "utf8");
const lock = JSON.parse(lockText);
const lockSha256 = createHash("sha256").update(lockText).digest("hex");

function manifestFor(lockPath) {
  const manifestPath = join(root, lockPath, "package.json");
  if (!existsSync(manifestPath)) return null;
  try { return JSON.parse(readFileSync(manifestPath, "utf8")); } catch { return null; }
}

const inventory = [];
for (const [lockPath, entry] of Object.entries(lock.packages ?? {})) {
  if (!lockPath.includes("node_modules/") || entry.link || typeof entry.version !== "string") continue;
  const manifest = manifestFor(lockPath);
  // Names and licenses come from the lockfile even if this machine has only a
  // partial server install. Installed manifests must not silently omit clients.
  const name = typeof entry.name === "string" ? entry.name : lockPath.slice(lockPath.lastIndexOf('node_modules/')+'node_modules/'.length);
  const license = typeof entry.license === "string" ? entry.license : "UNKNOWN";
  inventory.push({
    name,
    version: entry.version,
    license,
    installScript: entry.hasInstallScript === true,
    nativeAddon: existsSync(join(root, lockPath, "binding.gyp")) || manifest?.gypfile === true || String(manifest?.main ?? "").endsWith(".node"),
  });
}

const unique = [...new Map(inventory.map((component) => [`${component.name}@${component.version}`, component])).values()]
  .sort((left, right) => left.name.localeCompare(right.name) || left.version.localeCompare(right.version));
const components = unique.map(({ name, version, license }) => ({
  type: "library",
  "bom-ref": `pkg:npm/${encodeURIComponent(name)}@${version}`,
  name,
  version,
  licenses: license === "UNKNOWN" ? [] : [{ license: { name: license } }],
  purl: `pkg:npm/${encodeURIComponent(name)}@${version}`,
  properties: [{ name: "kavaroutes:license-review", value: license }],
}));

// Generate evidence only from this invocation's registry response. A caller
// flag must never manufacture a clean advisory scan or reuse a stale date.
const auditCommand=['audit','--json','--audit-level=low'];
let audit;
try{audit=JSON.parse(execFileSync('npm',auditCommand,{cwd:root,encoding:'utf8',maxBuffer:10_000_000}));}
catch{throw new Error('DEPENDENCY_AUDIT_FAILED: evidence was not updated');}
const vulnerabilities=audit.metadata?.vulnerabilities;
if(!vulnerabilities||vulnerabilities.total!==0)throw new Error('DEPENDENCY_AUDIT_NOT_CLEAN: evidence was not updated');

const outputDirectory = join(root, "artifacts", "dependencies");
mkdirSync(outputDirectory, { recursive: true });
writeFileSync(join(outputDirectory, "audit-sbom.cdx.json"), `${JSON.stringify({
  bomFormat: "CycloneDX",
  specVersion: "1.6",
  version: 1,
  metadata: { component: { type: "application", name: lock.name, version: lock.version } },
  components,
}, null, 2)}\n`);

const report = {
  schemaVersion: "kavaroutes.dependency-assurance.v1",
  evidenceDate: new Date().toISOString().slice(0, 10),
  lockSha256,
  componentCount: components.length,
  advisoryCheck: {
    command: "npm audit --json --audit-level=low",
    online: true,
    exitCode: 0,
    vulnerabilities,
  },
  installScriptReview: unique.filter((component) => component.installScript).map(({ name, version }) => ({ name, version, disposition: name === "protobufjs"
    ? "reviewed: reads adjacent package metadata and may emit a compatibility warning; no network, child process, or file write"
    : "platform-optional dependency" })),
  nativeAddonReviewLimitation: "Installed-tree indicators only; review native build artifacts separately on supported platforms.",
  nativeAddonReview: unique.filter((component) => component.nativeAddon).map(({ name, version }) => ({ name, version, disposition: "retain pinned version; exercise on supported build platforms" })),
  unknownLicenseReview: unique.filter((component) => component.license === "UNKNOWN").map(({ name, version }) => ({ name, version, disposition: "manual review required before distribution" })),
  exceptions: [],
};
writeFileSync(join(outputDirectory, "audit-assurance.json"), `${JSON.stringify(report, null, 2)}\n`);
console.log(`Dependency assurance generated: ${components.length} components, ${vulnerabilities.total} advisories.`);
