import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalJson, normalizeBundle, readJson } from "../lib/contracts.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const classifications = await readJson(join(root, "catalog", "classifications.json"));
const policy = await readJson(join(root, "catalog", "policy-registry.json"));
const assurance = await readJson(join(root, "hipaa", "assurance-registry.json"));
const flows = await readJson(join(root, "flows", "synthetic-flows.json"));
const output = normalizeBundle(classifications, policy, assurance, flows);
await mkdir(join(root, "normalized"), { recursive: true });
await writeFile(join(root, "normalized", "privacy-assurance-contract.json"), canonicalJson(output));
console.log(`Generated deterministic privacy assurance contract ${output.digest}.`);
