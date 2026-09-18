import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeBundle, readJson } from "./lib/contracts.mjs";

const root = dirname(fileURLToPath(import.meta.url));

/**
 * Load and validate the privacy-governance sources as one project contract.
 * Consumers receive both source registries and their normalized form without
 * duplicating knowledge of this package's directory layout.
 */
export async function loadPrivacyBundle() {
  const [classifications, policy, assurance, flows] = await Promise.all([
    readJson(join(root, "catalog", "classifications.json")),
    readJson(join(root, "catalog", "policy-registry.json")),
    readJson(join(root, "hipaa", "assurance-registry.json")),
    readJson(join(root, "flows", "synthetic-flows.json")),
  ]);
  const normalized = normalizeBundle(classifications, policy, assurance, flows);
  return { classifications, policy, assurance, flows, normalized };
}

export * from "./lib/contracts.mjs";
