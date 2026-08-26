import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const read = async (name) => JSON.parse(await readFile(resolve(root, "artifacts", name), "utf8"));
const lint = await read("local-lint-report.json"); const native = await read("native-config-report.json"); const benchmark = await read("local-benchmark.json"); const dependencies = await read("dependency-report.json");
const androidApk = await read("android-apk-report.json"); const iosBundle = await read("ios-bundle-report.json");
for (const artifact of [lint, native, dependencies]) assert.equal(artifact.result, "PASS"); assert.equal(benchmark.samples, 2_880);
assert.equal(androidApk.result, "PASS_DEVELOPMENT_APK_CREATED"); assert.equal(iosBundle.result, "PASS_IOS_HERMES_BUNDLE_CREATED");
const { generatedAt: _generatedAt, generationMs: _generationMs, batchingMs: _batchingMs, fakeTransactionalPersistMs: _fakeTransactionalPersistMs, ...stableBenchmark } = benchmark;
const evidenceDigest = createHash("sha256").update(JSON.stringify({ lint, native, benchmark: stableBenchmark, dependencies })).digest("hex");
const bundleDirectory = resolve(root, "../../apps/driver/dist/export/_expo/static/js/android");
const bundleNames = await readdir(bundleDirectory); const bundleName = bundleNames.find((name) => name.endsWith(".hbc"));
assert.ok(bundleName); const bundleBytes = (await stat(resolve(bundleDirectory, bundleName))).size;
const report = { format: 1, workPackage: "010", decision: "BLOCKED_PENDING_HIG_006", localPhase: "PASS", evidenceDigest,
  evidenceDigestInputs: ["local-lint-report.json", "native-config-report.json", "stable fields from local-benchmark.json", "dependency-report.json"],
  framework: { expo: lint.expo, reactNative: lint.reactNative, react: lint.react, newArchitecture: true, hermes: true },
  localEvidence: { closedSchemas: lint.schemas, localMigrations: lint.migrations, routeSurfaces: lint.routeSurfaces, deterministicNativeConfigDigest: native.digest,
    androidBundle: "PASS", androidHermesBundleBytes: bundleBytes, offlineHours: benchmark.offlineHours, offlineSamples: benchmark.samples, batches: benchmark.batches, vulnerabilities: 0 },
  preparedArtifacts: { androidDevelopmentApk: { result: androidApk.result, artifact: androidApk.artifact, bytes: androidApk.bytes, sha256: androidApk.sha256,
      sourceDigest: androidApk.sourceDigest, signing: androidApk.signing.kind, physicalInstallExecuted: androidApk.physicalInstallExecuted },
    iosHermesBundle: { result: iosBundle.result, artifact: iosBundle.artifact, bytes: iosBundle.bytes, sha256: iosBundle.sha256,
      generatedXcodeProject: iosBundle.generatedXcodeProject, cngProjectPrepared: iosBundle.cngProjectPrepared,
      developmentStatus: iosBundle.developmentStatus, installableBinary: iosBundle.installableBinary, xcodeBuildExecuted: iosBundle.xcodeBuildExecuted } },
  evidenceDigestExcludes: ["benchmark.generatedAt", "benchmark.generationMs", "benchmark.batchingMs", "benchmark.fakeTransactionalPersistMs"],
  platformDecisions: { android: "DEVELOPMENT_APK_READY_PHYSICAL_EVIDENCE_PENDING", ios: "DEFERRED_PENDING_MACOS_XCODE", reactNative: "CONDITIONAL_LOCAL_LANE_PASSES" },
  requiredPhysicalEvidence: { currentIphone: true, currentStockAndroid: true, aggressiveOemAndroid: true, oldestSupportedAvailable: true, continuousShiftHoursPerDevice: 8,
    iosDevelopmentDeferred: true, movingFreshnessP95SecondsMaximum: 15, staleSecondsMaximum: 60,
    attributableBatteryPercentagePointsPerHourMaximum: 2, talkBack: true, voiceOver: true },
  prohibitedClaims: ["production Driver", "background reliability", "battery feasibility", "platform go", "PHI readiness", "store readiness", "commercial device support"],
  nextGate: "HIG-006" };
await writeFile(resolve(root, "artifacts/feasibility-report.json"), `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`WP010 local feasibility report generated (${evidenceDigest}; HIG-006 still mandatory)\n`);
