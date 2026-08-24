import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readJson } from "../lib/contracts.mjs";

export const root = join(dirname(fileURLToPath(import.meta.url)), "..");

export async function loadBundle() {
  const [glossary, aggregates, machines, catalog, constraints, policies, scenarios] = await Promise.all([
    readJson(join(root, "catalog", "glossary.json")),
    readJson(join(root, "catalog", "aggregates.json")),
    readJson(join(root, "machines", "state-machines.json")),
    readJson(join(root, "catalog", "command-event-catalog.json")),
    readJson(join(root, "catalog", "constraints.json")),
    readJson(join(root, "catalog", "provisional-policies.json")),
    readJson(join(root, "scenarios", "golden-scenarios.json"))
  ]);
  return { glossary, aggregates, machines, catalog, constraints, policies, scenarios };
}
