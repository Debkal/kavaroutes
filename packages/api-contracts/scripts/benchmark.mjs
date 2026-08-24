import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createWp007Api, parseStrictJson } from "../dist/index.js";

const root = resolve(fileURLToPath(new URL("../../../", import.meta.url)));
const app = await createWp007Api();
await app.ready();
const samples = [];
for (let index = 0; index < 120; index += 1) {
  const started = performance.now();
  const response = await app.inject({ method: "GET", url: "/v1/me", headers: { authorization: "Synthetic principal_dispatcher" } });
  assert.equal(response.statusCode, 200);
  if (index >= 20) samples.push(performance.now() - started);
}
await app.close();

const parserPayload = JSON.stringify({ items: Array.from({ length: 100 }, (_, index) => ({ id: index, label: `synthetic-${index}` })) });
const parserSamples = [];
for (let index = 0; index < 200; index += 1) {
  const started = performance.now();
  parseStrictJson(parserPayload);
  if (index >= 20) parserSamples.push(performance.now() - started);
}
const percentile = (values, fraction) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * fraction) - 1];
const round = (value) => Number(value.toFixed(3));
const report = {
  schemaVersion: "wp007.local-benchmark.v1",
  environment: "local-wsl-in-process-synthetic",
  http: { samples: samples.length, p50Milliseconds: round(percentile(samples, 0.5)), p95Milliseconds: round(percentile(samples, 0.95)), p95ThresholdMilliseconds: 250 },
  strictJson: { bytes: Buffer.byteLength(parserPayload), samples: parserSamples.length, p50Milliseconds: round(percentile(parserSamples, 0.5)), p95Milliseconds: round(percentile(parserSamples, 0.95)), p95ThresholdMilliseconds: 25 },
};
assert.ok(report.http.p95Milliseconds < report.http.p95ThresholdMilliseconds, "in-process HTTP p95 budget");
assert.ok(report.strictJson.p95Milliseconds < report.strictJson.p95ThresholdMilliseconds, "strict JSON p95 budget");
await writeFile(resolve(root, "packages/api-contracts/artifacts/benchmark.json"), `${JSON.stringify(report, null, 2)}\n`);
console.log(`wp007 benchmark: HTTP p95=${report.http.p95Milliseconds}ms, strict JSON p95=${report.strictJson.p95Milliseconds}ms`);
