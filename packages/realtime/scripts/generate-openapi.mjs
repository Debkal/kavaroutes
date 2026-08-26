import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createWp007Api } from "@kavaroutes/api-contracts";
import { createAuthorizationGenerationSource, createInMemoryRealtimeStore, createTestOnlyCursorCodec, REALTIME_LIMITS, REALTIME_PROTOCOL } from "../dist/index.js";
import { registerWp009Realtime } from "../dist/fastify.js";

function normalize(value) {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, normalize(item)]));
  return value;
}

const app = await createWp007Api();
try {
  const store = createInMemoryRealtimeStore(createTestOnlyCursorCodec());
  await registerWp009Realtime(app, { store, generationSource: createAuthorizationGenerationSource() });
  await app.ready();
  const document = normalize({ ...app.swagger(), servers: [], "x-kavaroutes-private-realtime": {
    public: false, route: "/v1/realtime", subprotocol: REALTIME_PROTOCOL, compression: false,
    maximumInboundBytes: REALTIME_LIMITS.maximumInboundBytes, authority: "PostgreSQL and REST cursor recovery",
  } });
  await writeFile(resolve(import.meta.dirname, "../artifacts/openapi.local.json"), `${JSON.stringify(document, null, 2)}\n`);
  process.stdout.write(`WP009 local OpenAPI generated (${Object.keys(document.paths).length} paths; private WebSocket extension)\n`);
} finally { await app.close(); }
