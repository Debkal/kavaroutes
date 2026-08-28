import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
const root = path.resolve(import.meta.dirname, "..");
const manifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
await mkdir(path.join(root, "artifacts"), { recursive: true });
await writeFile(path.join(root, "artifacts", "feasibility-report.json"), `${JSON.stringify({ schemaVersion: 1, workPackage: "WP011", decision: "CONDITIONAL_KEEP", exactDependencies: manifest.dependencies, routeArchitecture: "React Router Data Mode closed lazy route catalog", stateOwnership: ["TanStack Query REST", "immutable useSyncExternalStore projection", "validated safe URL", "component-local state"], virtualization: "NOT RETAINED; semantic table with a 200-row accessible page and filters after the 500-row render missed the 200 ms provisional gate", map: "provider-neutral deterministic synthetic adapter; zero Google calls", externalCostUsd: 0, limitations: ["Playwright WebKit is not branded Safari", "no VoiceOver/NVDA/JAWS evidence", "synthetic loopback slice only", "production identity, Maps, hosting, PHI, and complete workflows not implemented"] }, null, 2)}\n`);
console.log("WP011 feasibility report generated");
