import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { validateDeploymentRecords, verifyDeploymentProvenance } from "../scripts/verify-deployment-provenance.mjs";

const sha = (value) => createHash("sha256").update(value).digest("hex");
const image = (name, seed) => `us-west1-docker.pkg.dev/synthetic/repository/${name}@sha256:${sha(seed)}`;
const canonical = (value) => Array.isArray(value)
  ? `[${value.map(canonical).join(",")}]`
  : value !== null && typeof value === "object"
    ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`
    : JSON.stringify(value);

function git(root, ...args) {
  const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "kavaroutes-provenance-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "infra", "wp013"), { recursive: true });
  await mkdir(join(root, ".deployment-evidence"), { recursive: true });
  const tracked = {
    ".gitignore": ".deployment-evidence/\n",
    "infra/wp013/.terraform.lock.hcl": "provider lock\n",
    "infra/wp013/configuration.json": "{\"synthetic\":true}\n",
  };
  for (const [path, content] of Object.entries(tracked)) await writeFile(join(root, path), content);
  git(root, "init", "-q");
  git(root, "config", "user.name", "Audit Test");
  git(root, "config", "user.email", "audit@example.invalid");
  git(root, "add", ".gitignore", "infra/wp013/.terraform.lock.hcl", "infra/wp013/configuration.json");
  git(root, "commit", "-qm", "fixture");
  const commit = git(root, "rev-parse", "HEAD");

  const evidence = {
    ".deployment-evidence/reviewed.tfplan": "saved plan\n",
    ".deployment-evidence/api.sbom.json": "{\"bomFormat\":\"CycloneDX\"}\n",
    ".deployment-evidence/api.provenance.json": "{\"builder\":\"synthetic\"}\n",
  };
  for (const [path, content] of Object.entries(evidence)) await writeFile(join(root, path), content);
  const reference = async (path) => ({ path, sha256: sha(await readFile(join(root, path))) });
  const artifacts = [{
    name: "api",
    image: image("api", "deploy"),
    sbom: await reference(".deployment-evidence/api.sbom.json"),
    buildProvenance: await reference(".deployment-evidence/api.provenance.json"),
  }];
  const rollbackArtifacts = [{ name: "api", image: image("api", "rollback") }];
  const approval = {
    schemaVersion: "kavaroutes.deployment-approval.v1",
    gateId: "HIG-002",
    decision: "APPROVED",
    approvalId: "synthetic-approval-001",
    approvedAt: "2026-09-03T16:00:00.000Z",
    expiresAt: "2026-09-05T16:00:00.000Z",
    environment: "wp013-ephemeral-synthetic",
    dataClassification: "SYNTHETIC_NO_PHI",
    sourceCommit: commit,
    planSha256: (await reference(".deployment-evidence/reviewed.tfplan")).sha256,
    providerLockSha256: (await reference("infra/wp013/.terraform.lock.hcl")).sha256,
    configurationSha256: (await reference("infra/wp013/configuration.json")).sha256,
    artifactSetSha256: sha(canonical(artifacts.map(({ name, image: digestImage, sbom, buildProvenance }) => ({ name, image: digestImage, sbomSha256: sbom.sha256, buildProvenanceSha256: buildProvenance.sha256 })))),
    rollbackSourceCommit: commit,
    rollbackSetSha256: sha(canonical(rollbackArtifacts)),
  };
  const approvalPath = join(root, ".deployment-evidence", "approval.json");
  await writeFile(approvalPath, `${JSON.stringify(approval)}\n`);
  const manifest = {
    schemaVersion: "kavaroutes.deployment-provenance.v1",
    environment: approval.environment,
    dataClassification: approval.dataClassification,
    approvalSha256: sha(await readFile(approvalPath)),
    source: { repository: "kavaroutes", commit },
    plan: { tool: "opentofu-saved-plan", ...await reference(".deployment-evidence/reviewed.tfplan") },
    providerLock: await reference("infra/wp013/.terraform.lock.hcl"),
    configuration: await reference("infra/wp013/configuration.json"),
    artifacts,
    rollback: { sourceCommit: approval.rollbackSourceCommit, artifacts: rollbackArtifacts },
  };
  const manifestPath = join(root, ".deployment-evidence", "manifest.json");
  await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);
  return { root, manifest, approval, manifestPath, approvalPath };
}

test("a clean repository and exactly bound reviewed deployment pass", async (t) => {
  const value = await fixture(t);
  const report = await verifyDeploymentProvenance({ ...value, repositoryRoot: value.root, now: new Date("2026-09-04T00:00:00.000Z") });
  assert.deepEqual(report, { ok: true, findings: [] });
});

test("dirty and untracked source is rejected without mutation", async (t) => {
  const value = await fixture(t);
  await writeFile(join(value.root, "unreviewed.txt"), "unreviewed\n");
  const report = await verifyDeploymentProvenance({ ...value, repositoryRoot: value.root, now: new Date("2026-09-04T00:00:00.000Z") });
  assert.ok(report.findings.includes("SOURCE_WORKTREE_DIRTY"));
  assert.equal(await readFile(join(value.root, "unreviewed.txt"), "utf8"), "unreviewed\n");
});

test("tampering and approval drift fail closed", async (t) => {
  const value = await fixture(t);
  await writeFile(join(value.root, ".deployment-evidence", "reviewed.tfplan"), "changed plan\n");
  const drifted = structuredClone(value.approval);
  drifted.artifactSetSha256 = sha("different set");
  const findings = validateDeploymentRecords(value.manifest, drifted, new Date("2026-09-04T00:00:00.000Z"));
  assert.ok(findings.includes("APPROVED_ARTIFACT_SET_MISMATCH"));
  const report = await verifyDeploymentProvenance({ ...value, repositoryRoot: value.root, now: new Date("2026-09-04T00:00:00.000Z") });
  assert.ok(report.findings.includes("PLAN_EVIDENCE_DIGEST_MISMATCH"));
});

test("approval-file, tracked-input, and saved-plan boundaries are enforced", async (t) => {
  const value = await fixture(t);
  await writeFile(value.approvalPath, `${JSON.stringify({ ...value.approval, approvalId: "tampered-approval" })}\n`);
  let report = await verifyDeploymentProvenance({ ...value, repositoryRoot: value.root, now: new Date("2026-09-04T00:00:00.000Z") });
  assert.ok(report.findings.includes("APPROVAL_FILE_DIGEST_MISMATCH"));

  const untrackedPath = ".deployment-evidence/untracked.lock.hcl";
  await writeFile(join(value.root, untrackedPath), "untracked provider lock\n");
  const manifest = structuredClone(value.manifest);
  const approval = structuredClone(value.approval);
  manifest.providerLock = { path: untrackedPath, sha256: sha("untracked provider lock\n") };
  approval.providerLockSha256 = manifest.providerLock.sha256;
  await writeFile(value.approvalPath, `${JSON.stringify(approval)}\n`);
  manifest.approvalSha256 = sha(await readFile(value.approvalPath));
  await writeFile(value.manifestPath, `${JSON.stringify(manifest)}\n`);
  report = await verifyDeploymentProvenance({ ...value, repositoryRoot: value.root, now: new Date("2026-09-04T00:00:00.000Z") });
  assert.ok(report.findings.includes("PROVIDER_LOCK_NOT_TRACKED"));

  manifest.plan = { tool: "opentofu-saved-plan", ...manifest.configuration };
  approval.planSha256 = manifest.plan.sha256;
  await writeFile(value.approvalPath, `${JSON.stringify(approval)}\n`);
  manifest.approvalSha256 = sha(await readFile(value.approvalPath));
  await writeFile(value.manifestPath, `${JSON.stringify(manifest)}\n`);
  report = await verifyDeploymentProvenance({ ...value, repositoryRoot: value.root, now: new Date("2026-09-04T00:00:00.000Z") });
  assert.ok(report.findings.includes("SAVED_PLAN_MUST_NOT_BE_TRACKED"));
});

test("expired grants, mutable images, sensitive fields, and path traversal are rejected", async (t) => {
  const value = await fixture(t);
  const manifest = structuredClone(value.manifest);
  manifest.plan.path = "../reviewed.tfplan";
  manifest.artifacts[0].image = "us-west1-docker.pkg.dev/synthetic/repository/api:latest";
  manifest.secretToken = "must-not-exist";
  const findings = validateDeploymentRecords(manifest, value.approval, new Date("2026-09-06T00:00:00.000Z"));
  assert.ok(findings.includes("PLAN_EVIDENCE_PATH"));
  assert.ok(findings.includes("MUTABLE_IMAGE:api"));
  assert.ok(findings.some((finding) => finding.startsWith("SENSITIVE_FIELD:")));
  assert.ok(findings.includes("MANIFEST_FIELDS"));
  assert.ok(findings.includes("APPROVAL_NOT_ACTIVE"));
});

test("malformed nested records produce findings instead of throwing", async (t) => {
  const value = await fixture(t);
  const malformed = { ...value.manifest, artifacts: [null], rollback: { sourceCommit: "bad", artifacts: [null] } };
  const findings = validateDeploymentRecords(malformed, value.approval, new Date("2026-09-04T00:00:00.000Z"));
  assert.ok(findings.includes("ARTIFACT_TYPE"));
  assert.ok(findings.includes("ROLLBACK_ARTIFACT_TYPE"));
  assert.ok(findings.includes("ROLLBACK_SOURCE_COMMIT"));
});
