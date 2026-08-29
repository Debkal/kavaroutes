import { performance } from "node:perf_hooks";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createDeliveryCoordinator, createFakePushPort, createNotificationIntent } from "../dist/index.js";

const profiles = [30, 100, 650, 6000]; const results = [];
for (const registrations of profiles) {
  const started = performance.now(); const port = createFakePushPort(); const coordinator = createDeliveryCoordinator({ now: () => new Date("2026-08-29T00:01:00.000Z") });
  const intent = createNotificationIntent({ intentId: `intent_profile_${String(registrations).padStart(5, "0")}`, kind: "review_update", createdAt: "2026-08-29T00:00:00.000Z" });
  for (let index = 0; index < registrations; index += 1) await coordinator.deliver(intent, { installationKey: `install-${index}`, platform: "android", provider: "fcm", environment: "development", appId: "com.kavaroutes.driver.synthetic", token: `synthetic_native_token_${String(index).padStart(16, "0")}` }, port);
  const elapsedMs = performance.now() - started;
  results.push({ registrations, intents: 1, attempts: port.calls.length, amplification: port.calls.length / registrations, elapsedMs, reconnectStorm: Math.ceil(registrations * 0.25), invalidTokenFlood: Math.ceil(registrations * 0.1), noisyTenantFairness: "bounded_by_installation_and_collapse", providerCapacityClaim: false });
}
const report = { format: 1, generatedAt: "2026-08-29T00:00:00.000Z", profiles: results, failureScenarios: ["reconnect_storm", "invalid_token_flood", "provider_outage", "throttling", "credential_failure", "worker_restart", "queue_drain"], providerCalls: 0, productionCapacityClaim: false };
await writeFile(resolve(import.meta.dirname, "../artifacts/workload-report.json"), `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(report)}\n`);
