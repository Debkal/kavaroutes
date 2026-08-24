import { initializeTelemetry } from "./telemetry.js";
import { safePinoOptions } from "./logging.js";

const telemetry = initializeTelemetry();
const { createApi } = await import("./index.js");
const app = await createApi({ logger: safePinoOptions });

const shutdown = async () => {
  await app.close();
  await telemetry.shutdown();
};

process.once("SIGTERM", () => { void shutdown(); });
process.once("SIGINT", () => { void shutdown(); });

await app.listen({ host: "0.0.0.0", port: Number.parseInt(process.env.PORT ?? "3000", 10) });
