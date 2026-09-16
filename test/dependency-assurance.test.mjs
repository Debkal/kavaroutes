import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

const require = createRequire(import.meta.url);
const decodeUriComponent = require("decode-uri-component");
const queryString = require("query-string");

test("the CommonJS decoder preserves expected query-string behavior", () => {
  assert.equal(decodeUriComponent("hello%20world"), "hello world");
  assert.equal(decodeUriComponent("hello+world"), "hello world");
  assert.equal(decodeUriComponent("%E0%A4%A"), "%E0%A4%A");
  assert.deepEqual(queryString.parse("name=hello%20world&broken=%E0%A4%A"), Object.assign(Object.create(null), {
    broken: "%E0%A4%A",
    name: "hello world",
  }));
});

test("malformed percent input is handled within a linear-time budget", () => {
  const malformed = "%E0".repeat(20_000);
  const startedAt = performance.now();
  assert.equal(decodeUriComponent(malformed), malformed);
  assert.ok(performance.now() - startedAt < 1_000, "decoder exceeded the one-second safety budget");
});

test("dependency evidence is current, reproducible, and records owned exceptions", () => {
  const lock = readFileSync(new URL("../package-lock.json", import.meta.url), "utf8");
  const report = JSON.parse(readFileSync(new URL("../artifacts/dependencies/audit-assurance.json", import.meta.url), "utf8"));
  const sbom = JSON.parse(readFileSync(new URL("../artifacts/dependencies/audit-sbom.cdx.json", import.meta.url), "utf8"));
  assert.equal(report.lockSha256, createHash("sha256").update(lock).digest("hex"));
  assert.equal(report.advisoryCheck.online, true);
  assert.equal(report.advisoryCheck.vulnerabilities.total, 0);
  assert.equal(report.exceptions.some((exception) => exception.package === "decode-uri-component" && exception.owner), true);
  assert.equal(sbom.bomFormat, "CycloneDX"); assert.equal(sbom.specVersion, "1.6");
  assert.equal(sbom.components.length, report.componentCount);
});
