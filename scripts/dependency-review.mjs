import { mkdir, readFile, writeFile } from "node:fs/promises";

const lock = JSON.parse(await readFile(new URL("../package-lock.json", import.meta.url), "utf8"));
const packages = Object.entries(lock.packages)
  .filter(([location]) => location.startsWith("node_modules/"))
  .map(([location, metadata]) => ({
    name: location.slice("node_modules/".length),
    version: metadata.version,
    license: metadata.license ?? "UNKNOWN",
    integrity: metadata.integrity ?? null,
    resolved: metadata.resolved ?? null,
    hasInstallScript: metadata.hasInstallScript === true,
    optional: metadata.optional === true
  }))
  .sort((left, right) => left.name.localeCompare(right.name));

const direct = Object.entries({ ...(lock.packages[""].dependencies ?? {}), ...(lock.packages[""].devDependencies ?? {}) })
  .map(([name, requested]) => ({ name, requested, installed: lock.packages[`node_modules/${name}`]?.version ?? null }))
  .sort((left, right) => left.name.localeCompare(right.name));

const report = {
  generatedOn: new Date().toISOString().slice(0,10),
  updateOwner: "KavaRoutes platform maintainer",
  policy: "Exact versions and lockfile integrity are mandatory; review monthly and on security advisories.",
  advisoryScan: {
    executed: false,
    evidenceCommand: "npm run generate:audit-assurance",
    limitation: "This command inventories the lockfile only; it does not scan advisories or assert native compatibility.",
  },
  node: { version: process.version, npm: process.env.npm_config_user_agent ?? null },
  counts: {
    direct: direct.length,
    transitivePackageEntries: packages.length - direct.length,
    totalPackageEntries: packages.length,
    installScriptPackages: packages.filter((entry) => entry.hasInstallScript).length
  },
  direct,
  installScripts: packages.filter((entry) => entry.hasInstallScript).map((entry) => ({
    ...entry,
    command: entry.name === "protobufjs" ? "node scripts/postinstall" : "REVIEW_REQUIRED",
    execution: "blocked pending explicit npm allow-scripts approval"
  })),
  packages
};

await mkdir(new URL("../artifacts/dependencies/", import.meta.url), { recursive: true });
await writeFile(new URL("../artifacts/dependencies/wp005-dependency-review.json", import.meta.url), `${JSON.stringify(report, null, 2)}\n`);
console.log(`dependency review: ${report.counts.direct} direct, ${report.counts.transitivePackageEntries} transitive, ${report.counts.installScriptPackages} install-script packages`);
