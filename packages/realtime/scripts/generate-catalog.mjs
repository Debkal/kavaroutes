import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { PROTOCOL_CATALOG, realtimeSchemas } from "../dist/index.js";

function normalize(value) {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, normalize(item)]));
  return value;
}

const schemas = Object.fromEntries(realtimeSchemas.map((schema) => [schema.$id, normalize(schema)]).sort(([left], [right]) => left.localeCompare(right)));
const payload = normalize({ format: 1, catalog: PROTOCOL_CATALOG, schemas });
const canonical = JSON.stringify(payload);
const artifact = { ...payload, sha256: createHash("sha256").update(canonical).digest("hex") };
await writeFile(resolve(import.meta.dirname, "../artifacts/protocol-catalog.json"), `${JSON.stringify(artifact, null, 2)}\n`);
process.stdout.write(`WP009 protocol catalog generated (${artifact.sha256}, ${Object.keys(schemas).length} schemas)\n`);
