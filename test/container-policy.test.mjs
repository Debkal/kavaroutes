import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("local container definitions are pinned, non-root, bounded, health-checked, and cloud-free", async () => {
  const files = await Promise.all([
    readFile(new URL("../infra/wp005/api.Dockerfile", import.meta.url), "utf8"),
    readFile(new URL("../infra/wp005/worker.Dockerfile", import.meta.url), "utf8"),
    readFile(new URL("../infra/wp005/compose.yaml", import.meta.url), "utf8")
  ]);
  const all = files.join("\n");
  assert.ok(files[0].includes("node:24.19.0-bookworm-slim@sha256:"));
  assert.ok(files[1].includes("node:24.19.0-bookworm-slim@sha256:"));
  assert.ok(files[0].includes("USER node") && files[1].includes("USER node"));
  assert.ok(all.includes("postgis/postgis:17-3.5@sha256:"));
  assert.ok(all.includes("HEALTHCHECK") && all.includes("healthcheck:"));
  assert.ok(all.includes("read_only: true") && all.includes("stop_grace_period:"));
  assert.ok(!all.includes(":latest"));
  assert.ok(!/google|gcloud|kubernetes|terraform|cloud sql/i.test(all));
  assert.ok(!/password:\s+[^$]/i.test(files[2]));
});
