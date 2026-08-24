import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { canonicalJson, normalizeBundle } from "../lib/contracts.mjs";
import { loadBundle, root } from "./load.mjs";

const normalized = normalizeBundle(await loadBundle());
const targetDirectory = join(root, "normalized");
const target = join(targetDirectory, "nemt-domain-contract.json");
await mkdir(targetDirectory, { recursive:true });
await writeFile(target, canonicalJson(normalized), "utf8");
console.log(`Generated deterministic NEMT domain contract ${normalized.digest}.`);
