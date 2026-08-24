import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { canonicalJson, normalizeProfile, normalizeScenario, readJson, readJsonDirectory, validateResult } from "../lib/contracts.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const profiles = await readJsonDirectory(join(root, "profiles"));
const scenarios = await readJsonDirectory(join(root, "scenarios"));
const resultTemplate = await readJson(join(root, "results", "result-template.json"));

const profileIds = new Set();
for (const profile of profiles) {
  if (profileIds.has(profile.id)) throw new Error(`duplicate profile ID ${profile.id}`);
  profileIds.add(profile.id);
  if (canonicalJson(normalizeProfile(profile)) !== canonicalJson(normalizeProfile(profile))) throw new Error(`profile ${profile.id} is not deterministic`);
}

const scenarioIds = new Set();
let combinations = 0;
for (const scenario of scenarios) {
  if (scenarioIds.has(scenario.id)) throw new Error(`duplicate scenario ID ${scenario.id}`);
  scenarioIds.add(scenario.id);
  const compatible = profiles.filter((profile) => scenario.profileIds.includes("*") || scenario.profileIds.includes(profile.id));
  if (compatible.length === 0) throw new Error(`scenario ${scenario.id} has no compatible profile`);
  for (const profile of compatible) {
    if (canonicalJson(normalizeScenario(scenario, profile)) !== canonicalJson(normalizeScenario(scenario, profile))) throw new Error(`scenario ${scenario.id}/${profile.id} is not deterministic`);
    combinations += 1;
  }
}

validateResult(resultTemplate);
if (profiles.length !== 4) throw new Error(`expected 4 profiles, found ${profiles.length}`);
if (scenarios.length !== 8) throw new Error(`expected 8 scenarios, found ${scenarios.length}`);
console.log(`Validated ${profiles.length} profiles, ${scenarios.length} scenarios, ${combinations} compatible combinations, and 1 result template.`);
