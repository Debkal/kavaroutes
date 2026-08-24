import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("architecture checker fails closed on framework leakage into a domain", async () => {
  const fixture = await mkdtemp(path.join(tmpdir(), "kavaroutes-wp005-boundary-"));
  try {
    await mkdir(path.join(fixture, "apps"), { recursive: true });
    await mkdir(path.join(fixture, "packages", "bad-domain", "src", "domain"), { recursive: true });
    await writeFile(path.join(fixture, "packages", "bad-domain", "package.json"), JSON.stringify({ exports: { ".": "./dist/index.js" } }));
    await writeFile(path.join(fixture, "packages", "bad-domain", "src", "domain", "index.ts"), "import Fastify from 'fastify';\nexport { Fastify };\n");
    const result = spawnSync(process.execPath, [new URL("../scripts/check-architecture.mjs", import.meta.url).pathname, fixture], { encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}${result.stderr}`, /domain import fastify|framework\/platform leakage/);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});
