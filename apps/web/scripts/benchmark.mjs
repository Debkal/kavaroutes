import { performance } from "node:perf_hooks";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

function makeTrips(count) { return Array.from({ length: count }, (_, index) => ({ reference: `trip-synthetic-${String(index + 1).padStart(5, "0")}`, status: ["SCHEDULED", "READY", "IN_PROGRESS", "LATE", "COMPLETED"][index % 5], time: `${String(6 + Math.floor((index % 720) / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}` })); }
function percentile(values, quantile) { const sorted = values.toSorted((a, b) => a - b); return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * quantile))] ?? 0; }
const profiles = [{ name: "small", trips: 500, markers: 25, changesPerSecond: 5 }, { name: "p0", trips: 1500, markers: 75, changesPerSecond: 15 }, { name: "enterprise", trips: 10000, markers: 500, changesPerSecond: 100 }];
const results = profiles.map((profile) => {
  const source = makeTrips(profile.trips); const samples = [];
  for (let run = 0; run < 40; run += 1) { const started = performance.now(); source.filter((trip) => trip.status === "LATE").toSorted((a, b) => a.time.localeCompare(b.time)); samples.push(performance.now() - started); }
  const updates = new Map(); const updateStarted = performance.now();
  for (let second = 0; second < 10; second += 1) for (let index = 0; index < profile.changesPerSecond; index += 1) updates.set(`vehicle-${index % profile.markers}`, { version: second + 1 });
  const updateMilliseconds = performance.now() - updateStarted;
  return { ...profile, filterSortP50Milliseconds: percentile(samples, .5), filterSortP95Milliseconds: percentile(samples, .95), coalescedVehicles: updates.size, acceptedChanges: profile.changesPerSecond * 10, coalescingDroppedIntermediate: profile.changesPerSecond * 10 - updates.size, updateMilliseconds, digest: createHash("sha256").update(JSON.stringify([...updates])).digest("hex") };
});
const report = { schemaVersion: 1, generatedAt: new Date().toISOString(), runtime: process.version, conditions: "WSL local Node pure-state measurement; not Core Web Vitals or production capacity", profiles: results };
const artifacts = path.resolve(import.meta.dirname, "../artifacts");
await mkdir(artifacts, { recursive: true });
await writeFile(path.join(artifacts, "workload-report.json"), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
