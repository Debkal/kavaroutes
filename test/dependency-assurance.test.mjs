import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

test("dependency evidence is current, reproducible, and records owned exceptions", () => {
  const lock = readFileSync(new URL("../package-lock.json", import.meta.url), "utf8");
  const report = JSON.parse(readFileSync(new URL("../artifacts/dependencies/audit-assurance.json", import.meta.url), "utf8"));
  const sbom = JSON.parse(readFileSync(new URL("../artifacts/dependencies/audit-sbom.cdx.json", import.meta.url), "utf8"));
  assert.equal(report.lockSha256, createHash("sha256").update(lock).digest("hex"));
  assert.equal(report.advisoryCheck.online, true);
  assert.equal(report.advisoryCheck.vulnerabilities.total, 0);
  assert.deepEqual(report.exceptions, []);
  assert.equal(sbom.bomFormat, "CycloneDX"); assert.equal(sbom.specVersion, "1.6");
  assert.equal(sbom.components.length, report.componentCount);
  // The client packages remain in the SBOM on a machine with a server-only install.
  for (const name of ['firebase','expo-location','leaflet','jsdom']) assert.ok(sbom.components.some(component=>component.name===name),`missing ${name}`);
});
