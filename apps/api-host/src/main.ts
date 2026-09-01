import { initializeTelemetry } from "./telemetry.js";
import { safePinoOptions } from "./logging.js";
import { resolveApiHostRuntime } from "./network-security.js";

const runtime = resolveApiHostRuntime(process.env);
const telemetry = initializeTelemetry();
const { createApi } = await import("./index.js");
const app = await createApi({ logger: safePinoOptions });

const shutdown = async () => {
  await app.close();
  await telemetry.shutdown();
};

process.once("SIGTERM", () => { void shutdown(); });
process.once("SIGINT", () => { void shutdown(); });

await app.listen({ host: runtime.host, port: runtime.port });
