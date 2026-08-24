import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { FAILURE_POLICIES, ROUTE_POLICIES } from "../dist/index.js";

const root = resolve(import.meta.dirname, "..");
await writeFile(resolve(root, "artifacts/route-policy-catalog.json"), `${JSON.stringify({ format: 1, routes: Object.values(ROUTE_POLICIES) }, null, 2)}\n`);
await writeFile(resolve(root, "artifacts/failure-policy-catalog.json"), `${JSON.stringify({ format: 1, failures: FAILURE_POLICIES }, null, 2)}\n`);
process.stdout.write("WP008 route and failure catalogs generated\n");
