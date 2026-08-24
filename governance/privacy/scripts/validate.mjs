import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalJson, normalizeBundle, readJson } from "../lib/contracts.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const classifications = await readJson(join(root, "catalog", "classifications.json"));
const policy = await readJson(join(root, "catalog", "policy-registry.json"));
const assurance = await readJson(join(root, "hipaa", "assurance-registry.json"));
const flows = await readJson(join(root, "flows", "synthetic-flows.json"));
const first = canonicalJson(normalizeBundle(classifications, policy, assurance, flows));
const second = canonicalJson(normalizeBundle(classifications, policy, assurance, flows));
if (first !== second) throw new Error("normalized privacy bundle is not deterministic");
console.log(`Validated ${classifications.classifications.length} classifications, ${policy.fields.length} fields, ${assurance.controls.length} controls, ${assurance.evidence.length} evidence records, and ${flows.flows.length} synthetic flows.`);
