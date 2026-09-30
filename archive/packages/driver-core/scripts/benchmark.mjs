import { performance } from "node:perf_hooks";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createDeterministicEncryptedStoreFake, createLocationBatches, DEFAULT_SAMPLING_POLICY, normalizeLocation } from "../dist/index.js";

const started = performance.now();
const samples = Array.from({ length: 2_880 }, (_, index) => normalizeLocation({ sampleId: `loc_${String(index + 1).padStart(16, "0")}`, epoch: 1, sequence: index + 1,
  capturedAt: new Date(Date.UTC(2026, 7, 25, 0, 0, index * 15)).toISOString(), latitude: 34 + ((index % 25) / 100_000), longitude: -118 - ((index % 25) / 100_000), accuracyMeters: 8 }, DEFAULT_SAMPLING_POLICY));
const generatedMs = performance.now() - started;
const batchStarted = performance.now(); const batches = createLocationBatches(samples, DEFAULT_SAMPLING_POLICY); const batchMs = performance.now() - batchStarted;
const store = createDeterministicEncryptedStoreFake(); await store.initialize({ installationGeneration: "inst_0000000000000001", keyMaterial: "key_synthetic_0000000000000001" });
const persistStarted = performance.now(); await store.transaction(async (tx) => tx.appendLocations(samples)); const persistMs = performance.now() - persistStarted;
const serializedBytes = Buffer.byteLength(JSON.stringify(samples));
const report = { format: 1, scope: "local-fake-not-native-capacity", generatedAt: new Date().toISOString(), offlineHours: 12, intervalSeconds: 15, samples: samples.length,
  batches: batches.length, maximumBatchItems: Math.max(...batches.map((batch) => batch.length)), maximumBatchBytes: Math.max(...batches.map((batch) => Buffer.byteLength(JSON.stringify(batch)))),
  serializedBytes, generationMs: generatedMs, batchingMs: batchMs, fakeTransactionalPersistMs: persistMs, duplicates: 0, gaps: 0, physicalDeviceEvidence: false,
  freshnessMeasured: false, batteryMeasured: false, productionCapacityClaim: false, completionBlockedBy: "HIG-006" };
if (report.samples < 2_880 || report.maximumBatchItems > 500 || report.maximumBatchBytes > 1_048_576 || store.inspect().locations.size !== 2_880) throw new Error("WP010_LOCAL_BENCHMARK_FAILED");
await writeFile(resolve(import.meta.dirname, "../artifacts/local-benchmark.json"), `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`WP010 local offline benchmark passed (${report.samples} samples in ${report.batches} batches; no device/battery claim)\n`);
