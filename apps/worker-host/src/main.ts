import { initializeWorkerTelemetry } from "./telemetry.js";

const telemetry = initializeWorkerTelemetry();
const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL_REQUIRED");
const { createWorkerHost } = await import("./index.js");
const worker = createWorkerHost(connectionString, async () => {});
await worker.start();

const shutdown = async () => {
  await worker.stop();
  await telemetry.shutdown();
};
process.once("SIGTERM", () => { void shutdown(); });
process.once("SIGINT", () => { void shutdown(); });
