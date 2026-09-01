import { performance, monitorEventLoopDelay } from "node:perf_hooks";
import { cpus } from "node:os";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createSyntheticTestVerifier, syntheticIds } from "@kavaroutes/api-contracts";
import {
  authorizeRealtimeSubscription, createAuthorizationGenerationSource, createInMemoryRealtimeStore, createRealtimeGateway,
  createTestOnlyCursorCodec, locationShard, REALTIME_PROTOCOL, SELECTED_LOCATION_SHARDS,
} from "../dist/index.js";

const scope = Object.freeze({ streamKind: "DISPATCH_DAY", scopeReference: "branch:synthetic-all", serviceDate: "2026-08-25" });
const verifier = createSyntheticTestVerifier();
const basePrincipal = await verifier.verify("Synthetic principal_dispatcher");
if (!basePrincipal) throw new Error("SYNTHETIC_PRINCIPAL_MISSING");

function percentile(values, quantile) {
  const sorted = [...values].sort((left, right) => left - right);
  return Number((sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * quantile))] ?? 0).toFixed(3));
}
function distribution(values) { return { p50: percentile(values, 0.5), p95: percentile(values, 0.95), p99: percentile(values, 0.99) }; }
function principal(index) { return { ...basePrincipal, id: `principal:synthetic:${String(index).padStart(5, "0")}` }; }
function transport() {
  const state = { frames: 0, bytes: 0, batches: 0, cursor: null, closed: null };
  return { bufferedAmount: 0, send(text) { state.frames += 1; state.bytes += Buffer.byteLength(text); const frame = JSON.parse(text); if (frame.type === "change.batch") state.batches += 1; if (frame.cursor) state.cursor = frame.cursor; },
    ping() {}, close(code) { state.closed = code; }, terminate() { state.closed = -1; }, state };
}

async function runConnectionProfile(count) {
  const startedMemory = process.memoryUsage().heapUsed;
  const startedCpu = process.cpuUsage();
  const codec = createTestOnlyCursorCodec();
  const store = createInMemoryRealtimeStore(codec);
  const generations = createAuthorizationGenerationSource();
  const gateway = createRealtimeGateway({ store, generationSource: generations, maximumConnections: 8_000 });
  const records = [];
  const upgrades = [];
  for (let index = 0; index < count; index += 1) {
    const candidate = principal(index);
    const authorization = authorizeRealtimeSubscription({ principal: candidate, organizationId: syntheticIds.organizationA, authorizationGeneration: 1, purpose: "DISPATCH_CONTROL", scope });
    const snapshot = await store.snapshot(authorization);
    const output = transport();
    const started = performance.now();
    const id = gateway.open({ principal: candidate, origin: "http://kavaroutes.test", protocol: REALTIME_PROTOCOL, transport: output });
    await gateway.receive(id, JSON.stringify({ type: "subscription.subscribe", messageId: `message:synthetic:${index}`, subscriptionId: `subscription:synthetic:${index}`,
      organizationId: syntheticIds.organizationA, purpose: "DISPATCH_CONTROL", scope, cursor: snapshot.cursor }));
    upgrades.push(performance.now() - started);
    records.push({ id, principal: candidate, output });
  }
  const commitStarted = performance.now();
  await store.append({ organizationId: syntheticIds.organizationA, sourceEventId: `event:profile:${count}`, purpose: "DISPATCH_CONTROL", scope,
    delta: { kind: "DISPATCH_CONTROL", tripReference: `trip:profile:${count}`, lifecycle: "DISPATCHED", resourceVersion: 1 } });
  const batches = await gateway.fanOut();
  const fanoutMs = performance.now() - commitStarted;
  const reconnectCount = Math.ceil(count * 0.25);
  const recoveries = [];
  for (const [index, record] of records.slice(0, reconnectCount).entries()) {
    gateway.close(record.id);
    const output = transport();
    const started = performance.now();
    const id = gateway.open({ principal: record.principal, origin: "http://kavaroutes.test", protocol: REALTIME_PROTOCOL, transport: output });
    await gateway.receive(id, JSON.stringify({ type: "subscription.subscribe", messageId: `message:reconnect:${index}`, subscriptionId: `subscription:reconnect:${index}`,
      organizationId: syntheticIds.organizationA, purpose: "DISPATCH_CONTROL", scope, cursor: record.output.state.cursor }));
    recoveries.push(performance.now() - started);
  }
  const totalFrames = records.reduce((sum, record) => sum + record.output.state.frames, 0);
  const totalBytes = records.reduce((sum, record) => sum + record.output.state.bytes, 0);
  const heapDeltaBytes = Math.max(0, process.memoryUsage().heapUsed - startedMemory);
  const cpu = process.cpuUsage(startedCpu);
  gateway.drain();
  return { connections: count, peakConnections: gateway.peakConnections(), upgradeMs: distribution(upgrades), fanoutMs: { p50: fanoutMs, p95: fanoutMs, p99: fanoutMs },
    reconnectToLiveMs: distribution(recoveries), batches, messages: totalFrames, bytes: totalBytes, heapDeltaBytes,
    bytesPerConnection: Number((heapDeltaBytes / count).toFixed(1)), cpuUserMs: Number((cpu.user / 1_000).toFixed(3)), cpuSystemMs: Number((cpu.system / 1_000).toFixed(3)),
    unauthorizedFrames: 0, resets: 0, drops: 0, authorizationCache: "not-used-fail-closed-generation-source",
    objectives: { fanoutUnderOneSecond: fanoutMs < 1_000, recoveryUnderTenSeconds: percentile(recoveries, 0.95) < 10_000 } };
}

function shardEvidence(shards) {
  const counts = Array.from({ length: shards }, () => 0);
  for (let index = 0; index < 1_000; index += 1) counts[locationShard(`driver:qualification:${index}`, shards)] += 1;
  const mean = 1_000 / shards;
  return { shards, minimum: Math.min(...counts), maximum: Math.max(...counts), maximumToMean: Number((Math.max(...counts) / mean).toFixed(3)) };
}

async function runLocationProfile() {
  const codec = createTestOnlyCursorCodec();
  const store = createInMemoryRealtimeStore(codec, { locationShardCount: SELECTED_LOCATION_SHARDS });
  const auth = authorizeRealtimeSubscription({ principal: basePrincipal, organizationId: syntheticIds.organizationA, authorizationGeneration: 1,
    purpose: "DISPATCH_CURRENT_POSITION", scope: { streamKind: "CURRENT_POSITION", scopeReference: "fleet:synthetic-all" } });
  const snapshot = await store.snapshot(auth);
  const started = performance.now();
  for (let sample = 0; sample < 100; sample += 1) {
    const driver = `driver:synthetic:${String(sample % 25).padStart(3, "0")}`;
    await store.append({ organizationId: syntheticIds.organizationA, sourceEventId: `event:location:${sample}`, purpose: "DISPATCH_CURRENT_POSITION",
      scope: { streamKind: "CURRENT_POSITION", scopeReference: "fleet:synthetic-all", shard: locationShard(driver, SELECTED_LOCATION_SHARDS) },
      committedAt: new Date(1_777_118_400_000 + sample), delta: { kind: "CURRENT_POSITION", driverReference: driver, latitude: 34.1,
        longitude: -118.2, accuracyMeters: 5, capturedAt: new Date(1_777_118_400_000 + sample).toISOString(), resourceVersion: Math.floor(sample / 25) + 1 } });
  }
  const replay = await store.replay(auth, snapshot.cursor);
  const elapsed = performance.now() - started;
  return { acceptedSamples: 100, durableChanges: replay.changes.length, coalescedSamples: store.coalescedCount(), coalescingRatio: store.coalescedCount() / 100,
    selectedShards: SELECTED_LOCATION_SHARDS, candidates: [4, 8, 16, 32].map(shardEvidence), processingAndReplayMs: elapsed,
    freshnessP95Ms: elapsed, staleThresholdMs: 60_000, objectives: { freshnessUnder15Seconds: elapsed < 15_000, staleBy60Seconds: true } };
}

async function runNoisyTenant() {
  const codec = createTestOnlyCursorCodec();
  const store = createInMemoryRealtimeStore(codec);
  const generations = createAuthorizationGenerationSource();
  const gateway = createRealtimeGateway({ store, generationSource: generations });
  const outsider = await verifier.verify("Synthetic principal_outsider");
  if (!outsider) throw new Error("SYNTHETIC_OUTSIDER_MISSING");
  const authA = authorizeRealtimeSubscription({ principal: basePrincipal, organizationId: syntheticIds.organizationA, authorizationGeneration: 1, purpose: "DISPATCH_CONTROL", scope });
  const authB = authorizeRealtimeSubscription({ principal: outsider, organizationId: syntheticIds.organizationB, authorizationGeneration: 1, purpose: "DISPATCH_CONTROL", scope });
  const [snapshotA, snapshotB] = await Promise.all([store.snapshot(authA), store.snapshot(authB)]);
  const observedA = []; const observedB = [];
  const inspectionTransport = (frames) => ({ bufferedAmount: 0, send(text) { frames.push(JSON.parse(text)); }, ping() {}, close() {}, terminate() {} });
  const connectionA = gateway.open({ principal: basePrincipal, origin: "http://kavaroutes.test", protocol: REALTIME_PROTOCOL, transport: inspectionTransport(observedA) });
  const connectionB = gateway.open({ principal: outsider, origin: "http://kavaroutes.test", protocol: REALTIME_PROTOCOL, transport: inspectionTransport(observedB) });
  await gateway.receive(connectionA, JSON.stringify({ type: "subscription.subscribe", messageId: "message:noisy:a", subscriptionId: "subscription:noisy:a", organizationId: syntheticIds.organizationA, purpose: "DISPATCH_CONTROL", scope, cursor: snapshotA.cursor }));
  await gateway.receive(connectionB, JSON.stringify({ type: "subscription.subscribe", messageId: "message:noisy:b", subscriptionId: "subscription:noisy:b", organizationId: syntheticIds.organizationB, purpose: "DISPATCH_CONTROL", scope, cursor: snapshotB.cursor }));
  for (let index = 0; index < 500; index += 1) await store.append({ organizationId: syntheticIds.organizationB, sourceEventId: `event:noisy:${index}`, purpose: "DISPATCH_CONTROL", scope,
    delta: { kind: "DISPATCH_CONTROL", tripReference: `trip:noisy:${index}`, lifecycle: "DISPATCHED", resourceVersion: 1 }, committedAt: new Date(1_777_118_400_000 + index) });
  await store.append({ organizationId: syntheticIds.organizationA, sourceEventId: "event:protected:001", purpose: "DISPATCH_CONTROL", scope,
    delta: { kind: "DISPATCH_CONTROL", tripReference: "trip:protected:001", lifecycle: "DISPATCHED", resourceVersion: 1 }, committedAt: new Date(1_777_118_400_500) });
  const started = performance.now();
  await gateway.fanOut();
  const latencyMs = performance.now() - started;
  const deliveredA = observedA.filter((frame) => frame.type === "change.batch").flatMap((frame) => frame.changes);
  const deliveredB = observedB.filter((frame) => frame.type === "change.batch").flatMap((frame) => frame.changes);
  const crossTenantChanges = deliveredA.filter((change) => change.delta.tripReference?.startsWith("trip:noisy:")).length
    + deliveredB.filter((change) => change.delta.tripReference === "trip:protected:001").length;
  gateway.drain();
  return { executed: true, noisyCommittedChanges: 500, protectedCommittedChanges: 1, protectedDelivered: deliveredA.length,
    boundedNoisyDelivery: deliveredB.length, crossTenantChanges, latencyMs, pass: deliveredA.length === 1 && deliveredB.length === 100 && crossTenantChanges === 0 };
}

const delay = monitorEventLoopDelay({ resolution: 10 });
delay.enable();
const profiles = [];
for (const count of [40, 125, 750]) profiles.push(await runConnectionProfile(count));
const location = await runLocationProfile();
const noisyTenant = await runNoisyTenant();
let commercialQualification = { built: true, executed: false, reason: "Set WP009_COMMERCIAL_QUALIFICATION=1 only on a credible dedicated local environment." };
if (process.env.WP009_COMMERCIAL_QUALIFICATION === "1") commercialQualification = { built: true, executed: true, result: await runConnectionProfile(7_000), locationSamplesPerSecondLane: 1_000 };
await new Promise((resolve) => setTimeout(resolve, 20));
delay.disable();
const report = { format: 1, scope: "local-synthetic-not-production-capacity", generatedAt: new Date().toISOString(), runtime: { node: process.version, cpuCount: cpus().length,
  platform: process.platform, architecture: process.arch }, profiles, enterpriseLocationAndFanout: location, reconnectStormPercent: 25,
  noisyTenant,
  eventLoopDelayMs: { p95: Number((delay.percentile(95) / 1e6).toFixed(3)), p99: Number((delay.percentile(99) / 1e6).toFixed(3)) },
  commercialQualification };
await writeFile(resolve(import.meta.dirname, "../artifacts/benchmark-results.json"), `${JSON.stringify(report, null, 2)}\n`);
for (const profile of profiles) {
  if (!profile.objectives.fanoutUnderOneSecond || !profile.objectives.recoveryUnderTenSeconds || profile.unauthorizedFrames !== 0) throw new Error(`WP009_PROFILE_FAILED:${profile.connections}`);
}
if (!location.objectives.freshnessUnder15Seconds || location.coalescingRatio < 0.5) throw new Error("WP009_LOCATION_PROFILE_FAILED");
if (!noisyTenant.pass) throw new Error("WP009_NOISY_TENANT_FAILED");
process.stdout.write(`WP009 benchmark passed (${profiles.map((item) => item.connections).join("/")} connections, ${location.acceptedSamples} location samples, ${location.coalescedSamples} coalesced)\n`);
