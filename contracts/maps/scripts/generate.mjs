import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { canonicalJson, normalizeBundle } from "../lib/contracts.mjs";
import { loadBundle, loadProfiles, root } from "./load.mjs";

const normalized=normalizeBundle(await loadBundle(),await loadProfiles());
const directory=join(root,"normalized"),target=join(directory,"maps-policy-cost-contract.json");
await mkdir(directory,{recursive:true});await writeFile(target,canonicalJson(normalized),"utf8");
console.log(`Generated deterministic Maps policy and cost contract ${normalized.digest}.`);
