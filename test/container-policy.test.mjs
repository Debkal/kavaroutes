import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("local container definitions are pinned, non-root, bounded, health-checked, and cloud-free", async () => {
  const files = await Promise.all([
    readFile(new URL("../infra/wp005/api.Dockerfile", import.meta.url), "utf8"),
    readFile(new URL("../infra/wp005/worker.Dockerfile", import.meta.url), "utf8"),
    readFile(new URL("../infra/wp005/compose.yaml", import.meta.url), "utf8"),
    readFile(new URL("../infra/wp006/compose.yaml", import.meta.url), "utf8"),
    readFile(new URL("../.dockerignore", import.meta.url), "utf8")
  ]);
  const all = files.join("\n");
  assert.ok(files[0].includes("node:24.19.0-bookworm-slim@sha256:"));
  assert.ok(files[1].includes("node:24.19.0-bookworm-slim@sha256:"));
  assert.ok(files[0].includes("USER node") && files[1].includes("USER node"));
  assert.equal((files[0].match(/COPY (?:--from=build --chown=node:node \/app\/)?vendor/g) ?? []).length, 2);
  assert.equal((files[1].match(/COPY (?:--from=build --chown=node:node \/app\/)?vendor/g) ?? []).length, 2);
  assert.ok(all.includes("postgis/postgis:17-3.5@sha256:"));
  assert.ok(all.includes("HEALTHCHECK") && all.includes("healthcheck:"));
  assert.ok(all.includes("read_only: true") && all.includes("stop_grace_period:"));
  assert.equal((files[2].match(/no-new-privileges:true/g) ?? []).length, 3);
  assert.equal((files[2].match(/cap_drop:/g) ?? []).length, 3);
  assert.equal((files[2].match(/pids_limit:/g) ?? []).length, 3);
  assert.equal((files[2].match(/mem_limit:/g) ?? []).length, 3);
  assert.equal((files[2].match(/cpus:/g) ?? []).length, 3);
  assert.equal((files[2].match(/nofile:/g) ?? []).length, 3);
  for (const policy of ["no-new-privileges:true", "cap_drop:", "pids_limit:", "mem_limit:", "cpus:", "nofile:"]) assert.ok(files[3].includes(policy), policy);
  assert.ok(files[2].includes("noexec,nosuid,nodev"));
  assert.equal((files[2].match(/init: true/g) ?? []).length, 2);
  for (const localBoundary of ['NODE_ENV: "development"', 'KAVAROUTES_RUNTIME_PROFILE: "local-synthetic"', 'HOST: "127.0.0.1"']) assert.ok(files[2].includes(localBoundary), localBoundary);
  assert.ok(!all.includes(":latest"));
  assert.ok(!/google|gcloud|kubernetes|terraform|cloud sql/i.test(all));
  assert.ok(!/password:\s+[^$]/i.test(`${files[2]}\n${files[3]}`));
  for (const ignored of ["**/node_modules", "**/dist", "**/build", "**/.gradle", "**/.cxx", "**/.expo", "**/coverage", ".deployment-evidence", "**/*.tfplan", "**/*.tfstate", "**/*.tfstate.*", "**/*.apk", "**/*.aab", "**/*.so", "**/*.o"]) {
    assert.ok(files[4].split("\n").includes(ignored), `missing Docker context exclusion ${ignored}`);
  }
  assert.equal(files[4].split("\n").includes("vendor"), false, "local audited dependencies must remain in the Docker context");
});
