import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
const root = resolve(import.meta.dirname, "..");
const workload = JSON.parse(await readFile(resolve(root, "artifacts/workload-report.json"), "utf8"));
const evidence = { format: 1, decision: "LOCAL_KEEP_PROVIDER_CONFORMANCE_BLOCKED", policyVersion: "push.policy.v1", migration: "0010_push_installations_and_effects.sql",
  nativeLibrary: "expo-notifications", directAdapters: ["APNS_SANDBOX_HTTP2", "FCM_HTTP_V1"], providerCalls: 0,
  localProfiles: workload.profiles.map(({ registrations, attempts, amplification }) => ({ registrations, attempts, amplification })),
  permissionStates: ["not_requested", "provisional", "granted", "denied", "channel_limited", "system_disabled"],
  completionBlockedBy: "HIG-013_DIRECT_APNS_AND_FCM_PHYSICAL_DEVICE_CONFORMANCE", productionReady: false };
const canonical = JSON.stringify(evidence); const report = { ...evidence, sha256: createHash("sha256").update(canonical).digest("hex") };
await writeFile(resolve(root, "artifacts/feasibility-report.json"), `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(report)}\n`);
