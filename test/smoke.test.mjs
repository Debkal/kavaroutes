import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import test from "node:test";
import { createApi } from "@kavaroutes/api-host";

test("bounded ARQ-001-shaped framework smoke records measurements without a capacity claim", async (t) => {
  const app = await createApi({ operationIdFactory: () => "op_smoke_test_001" });
  t.after(() => app.close());
  const profile = JSON.parse(await readFile(new URL("../benchmarks/workloads/profiles/small-pilot.json", import.meta.url), "utf8"));
  assert.equal(profile.id, "small-pilot");
  const sampleCount = profile.dimensions.apiRate.value * 10;
  const durations = [];
  for (let index = 0; index < sampleCount; index += 1) {
    const start = performance.now();
    const response = await app.inject({ method: "GET", url: "/platform/v1/health" });
    durations.push(performance.now() - start);
    assert.equal(response.statusCode, 200);
  }
  durations.sort((a, b) => a - b);
  const percentile = (ratio) => durations[Math.min(durations.length - 1, Math.floor(durations.length * ratio))];
  const result = { samples: durations.length, p50Ms: percentile(0.5), p95Ms: percentile(0.95), p99Ms: percentile(0.99), capacityClaim: false };
  assert.equal(result.samples, sampleCount);
  assert.equal(result.capacityClaim, false);
  console.log(JSON.stringify({ wp005BoundedSmoke: result }));
});
