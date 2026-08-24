import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { createApi } from "../apps/api-host/dist/index.js";

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

const app = await createApi({ operationIdFactory: () => "op_openapi_generation" });
await app.ready();
const document = canonical(app.swagger());
const serialized = `${JSON.stringify(document, null, 2)}\n`;
await mkdir(new URL("../artifacts/openapi/", import.meta.url), { recursive: true });
await writeFile(new URL("../artifacts/openapi/wp005.openapi.json", import.meta.url), serialized);
await app.close();
console.log(`openapi sha256 ${createHash("sha256").update(serialized).digest("hex")}`);
