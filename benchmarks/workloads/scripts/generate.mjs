import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { canonicalJson, normalizeProfile, normalizeScenario, readJsonDirectory } from "../lib/contracts.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outputRoot = join(root, "normalized");
const profileOutput = join(outputRoot, "profiles");
const scenarioOutput = join(outputRoot, "scenarios");
await mkdir(profileOutput, { recursive: true });
await mkdir(scenarioOutput, { recursive: true });

const profiles = await readJsonDirectory(join(root, "profiles"));
const scenarios = await readJsonDirectory(join(root, "scenarios"));
let filesWritten = 0;
for (const profile of profiles) {
  await writeFile(join(profileOutput, `${profile.id}.json`), canonicalJson(normalizeProfile(profile)));
  filesWritten += 1;
}
for (const scenario of scenarios) {
  for (const profile of profiles) {
    if (!scenario.profileIds.includes("*") && !scenario.profileIds.includes(profile.id)) continue;
    await writeFile(join(scenarioOutput, `${scenario.id}--${profile.id}.json`), canonicalJson(normalizeScenario(scenario, profile)));
    filesWritten += 1;
  }
}
console.log(`Generated ${filesWritten} canonical contract files in ${outputRoot}.`);
