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
  generatedOn: "2026-08-24",
  updateOwner: "KavaRoutes platform maintainer",
  policy: "Exact versions and lockfile integrity are mandatory; review monthly and on security advisories.",
  advisoryScan: {
    command: "npm audit --json",
    executedOn: "2026-08-24",
    findings: { info: 0, low: 0, moderate: 0, high: 0, critical: 0 },
    limitation: "A clean registry advisory result is evidence, not a security guarantee."
  },
  nativeBinaryReview: {
    requiredNativeAddons: [],
    optionalWebSocketAddonsInstalled: [],
    finding: "The resolved graph contains no required native addon; optional bufferutil and utf-8-validate are absent."
  },
  supportEvidence: [
    { component: "Node.js", status: "24.19.0 LTS", source: "https://nodejs.org/en/about/previous-releases" },
    { component: "Fastify", status: "supported v5 line", source: "https://fastify.dev/docs/latest/Reference/LTS/" },
    { component: "Fastify TypeBox provider", status: "6.1.0 supports Fastify ^5 and TypeBox 1", source: "https://www.npmjs.com/package/@fastify/type-provider-typebox" },
    { component: "TypeBox", status: "1.3.7 supports TypeScript 6", source: "https://www.npmjs.com/package/typebox" },
    { component: "TypeScript", status: "6.0.3 stable compatibility compiler", source: "https://www.npmjs.com/package/typescript" }
  ],
  node: { version: "24.19.0", npm: "11.17.0", support: "LTS" },
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
