import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const defaultRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sha256Pattern = /^[a-f0-9]{64}$/;
const commitPattern = /^[a-f0-9]{40}$/;
const imagePattern = /^[^\s@]+@sha256:[a-f0-9]{64}$/;
const safeNamePattern = /^[a-z][a-z0-9-]{0,47}$/;
const allowedSensitiveKeyPattern = /^(?:dataClassification|buildProvenance)$/;
const sensitiveKeyPattern = /(?:password|passwd|token|secret|credential|private.?key|access.?key)/i;

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function exactObject(findings, code, value, keys) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    findings.push(`${code}_TYPE`);
    return false;
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (canonical(actual) !== canonical(expected)) findings.push(`${code}_FIELDS`);
  return true;
}

function inspectSensitiveKeys(findings, value, path = "root") {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => inspectSensitiveKeys(findings, entry, `${path}[${index}]`));
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const [key, nested] of Object.entries(value)) {
    if (sensitiveKeyPattern.test(key) && !allowedSensitiveKeyPattern.test(key)) findings.push(`SENSITIVE_FIELD:${path}.${key}`);
    inspectSensitiveKeys(findings, nested, `${path}.${key}`);
  }
}

function evidenceReference(findings, code, value) {
  if (!exactObject(findings, code, value, ["path", "sha256"])) return;
  if (typeof value.path !== "string" || value.path.length === 0 || isAbsolute(value.path) || value.path.includes("\\")) findings.push(`${code}_PATH`);
  if (typeof value.path === "string") {
    const normalized = value.path.split("/");
    if (normalized.includes("..") || normalized.includes("") || normalized[0] === ".git") findings.push(`${code}_PATH`);
  }
  if (!sha256Pattern.test(value.sha256)) findings.push(`${code}_SHA256`);
}

function artifactSet(artifacts) {
  return artifacts.map((artifact) => ({
    name: artifact?.name,
    image: artifact?.image,
    sbomSha256: artifact?.sbom?.sha256,
    buildProvenanceSha256: artifact?.buildProvenance?.sha256,
  })).sort((left, right) => String(left.name).localeCompare(String(right.name)));
}

function rollbackSet(artifacts) {
  return artifacts.map((artifact) => ({ name: artifact?.name, image: artifact?.image })).sort((left, right) => String(left.name).localeCompare(String(right.name)));
}

export function validateDeploymentRecords(manifest, approval, now = new Date()) {
  const findings = [];
  inspectSensitiveKeys(findings, manifest, "manifest");
  inspectSensitiveKeys(findings, approval, "approval");
  if (!exactObject(findings, "MANIFEST", manifest, ["schemaVersion", "environment", "dataClassification", "approvalSha256", "source", "plan", "providerLock", "configuration", "artifacts", "rollback"])) return findings;
  if (!exactObject(findings, "APPROVAL", approval, ["schemaVersion", "gateId", "decision", "approvalId", "approvedAt", "expiresAt", "environment", "dataClassification", "sourceCommit", "planSha256", "providerLockSha256", "configurationSha256", "artifactSetSha256", "rollbackSourceCommit", "rollbackSetSha256"])) return findings;

  if (manifest.schemaVersion !== "kavaroutes.deployment-provenance.v1") findings.push("MANIFEST_SCHEMA");
  if (approval.schemaVersion !== "kavaroutes.deployment-approval.v1") findings.push("APPROVAL_SCHEMA");
  if (manifest.environment !== "wp013-ephemeral-synthetic" || approval.environment !== manifest.environment) findings.push("ENVIRONMENT_BINDING");
  if (manifest.dataClassification !== "SYNTHETIC_NO_PHI" || approval.dataClassification !== manifest.dataClassification) findings.push("DATA_CLASSIFICATION_BINDING");
  if (approval.gateId !== "HIG-002" || approval.decision !== "APPROVED") findings.push("HUMAN_APPROVAL_REQUIRED");
  if (typeof approval.approvalId !== "string" || !/^[A-Za-z0-9._-]{1,64}$/.test(approval.approvalId)) findings.push("APPROVAL_ID");

  if (exactObject(findings, "SOURCE", manifest.source, ["repository", "commit"])) {
    if (manifest.source.repository !== "kavaroutes") findings.push("SOURCE_REPOSITORY");
    if (!commitPattern.test(manifest.source.commit)) findings.push("SOURCE_COMMIT");
  }
  if (!commitPattern.test(approval.sourceCommit) || approval.sourceCommit !== manifest.source?.commit) findings.push("APPROVED_SOURCE_MISMATCH");

  if (exactObject(findings, "PLAN", manifest.plan, ["tool", "path", "sha256"])) {
    if (manifest.plan.tool !== "opentofu-saved-plan") findings.push("PLAN_TOOL");
    evidenceReference(findings, "PLAN_EVIDENCE", { path: manifest.plan.path, sha256: manifest.plan.sha256 });
  }
  evidenceReference(findings, "PROVIDER_LOCK", manifest.providerLock);
  evidenceReference(findings, "CONFIGURATION", manifest.configuration);
  if (approval.planSha256 !== manifest.plan?.sha256) findings.push("APPROVED_PLAN_MISMATCH");
  if (approval.providerLockSha256 !== manifest.providerLock?.sha256) findings.push("APPROVED_PROVIDER_LOCK_MISMATCH");
  if (approval.configurationSha256 !== manifest.configuration?.sha256) findings.push("APPROVED_CONFIGURATION_MISMATCH");

  if (!Array.isArray(manifest.artifacts) || manifest.artifacts.length === 0) findings.push("ARTIFACTS_REQUIRED");
  const names = new Set();
  for (const artifact of Array.isArray(manifest.artifacts) ? manifest.artifacts : []) {
    if (!exactObject(findings, "ARTIFACT", artifact, ["name", "image", "sbom", "buildProvenance"])) continue;
    if (!safeNamePattern.test(artifact.name) || names.has(artifact.name)) findings.push("ARTIFACT_NAME");
    names.add(artifact.name);
    if (!imagePattern.test(artifact.image) || artifact.image.includes(":latest")) findings.push(`MUTABLE_IMAGE:${artifact.name}`);
    evidenceReference(findings, `SBOM:${artifact.name}`, artifact.sbom);
    evidenceReference(findings, `BUILD_PROVENANCE:${artifact.name}`, artifact.buildProvenance);
  }

  if (exactObject(findings, "ROLLBACK", manifest.rollback, ["sourceCommit", "artifacts"])) {
    if (!commitPattern.test(manifest.rollback.sourceCommit)) findings.push("ROLLBACK_SOURCE_COMMIT");
    if (!Array.isArray(manifest.rollback.artifacts) || manifest.rollback.artifacts.length === 0) findings.push("ROLLBACK_ARTIFACTS_REQUIRED");
  }
  if (approval.rollbackSourceCommit !== manifest.rollback?.sourceCommit) findings.push("APPROVED_ROLLBACK_SOURCE_MISMATCH");
  const rollbackNames = new Set();
  for (const artifact of Array.isArray(manifest.rollback?.artifacts) ? manifest.rollback.artifacts : []) {
    if (!exactObject(findings, "ROLLBACK_ARTIFACT", artifact, ["name", "image"])) continue;
    if (!safeNamePattern.test(artifact.name) || rollbackNames.has(artifact.name)) findings.push("ROLLBACK_ARTIFACT_NAME");
    rollbackNames.add(artifact.name);
    if (!imagePattern.test(artifact.image) || artifact.image.includes(":latest")) findings.push(`MUTABLE_ROLLBACK_IMAGE:${artifact.name}`);
    const deploy = Array.isArray(manifest.artifacts) ? manifest.artifacts.find((candidate) => candidate.name === artifact.name) : undefined;
    if (deploy?.image === artifact.image) findings.push(`ROLLBACK_NOT_DISTINCT:${artifact.name}`);
  }
  if (canonical([...names].sort()) !== canonical([...rollbackNames].sort())) findings.push("ROLLBACK_COMPONENT_MISMATCH");

  const artifacts = Array.isArray(manifest.artifacts) ? manifest.artifacts : [];
  const rollbackArtifacts = Array.isArray(manifest.rollback?.artifacts) ? manifest.rollback.artifacts : [];
  if (approval.artifactSetSha256 !== digest(canonical(artifactSet(artifacts)))) findings.push("APPROVED_ARTIFACT_SET_MISMATCH");
  if (approval.rollbackSetSha256 !== digest(canonical(rollbackSet(rollbackArtifacts)))) findings.push("APPROVED_ROLLBACK_SET_MISMATCH");
  if (!sha256Pattern.test(manifest.approvalSha256)) findings.push("APPROVAL_SHA256");

  const approvedAt = new Date(approval.approvedAt);
  const expiresAt = new Date(approval.expiresAt);
  if (!Number.isFinite(approvedAt.valueOf()) || !Number.isFinite(expiresAt.valueOf())) findings.push("APPROVAL_TIME");
  else {
    if (expiresAt <= approvedAt || expiresAt.valueOf() - approvedAt.valueOf() > 72 * 60 * 60 * 1000) findings.push("APPROVAL_WINDOW");
    if (now < approvedAt || now >= expiresAt) findings.push("APPROVAL_NOT_ACTIVE");
  }
  return [...new Set(findings)].sort();
}

function git(repositoryRoot, args) {
  const result = spawnSync("git", ["-C", repositoryRoot, ...args], { encoding: "utf8" });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

async function verifyEvidenceFile(repositoryRoot, reference, code) {
  if (!reference || typeof reference.path !== "string" || !sha256Pattern.test(reference.sha256)) return [];
  const candidate = resolve(repositoryRoot, reference.path);
  const relativePath = relative(repositoryRoot, candidate);
  if (relativePath.startsWith(`..${sep}`) || relativePath === ".." || isAbsolute(relativePath)) return [`${code}_OUTSIDE_REPOSITORY`];
  try {
    const stat = await lstat(candidate);
    if (!stat.isFile() || stat.isSymbolicLink()) return [`${code}_NOT_REGULAR_FILE`];
    const resolvedPath = await realpath(candidate);
    const resolvedRelative = relative(await realpath(repositoryRoot), resolvedPath);
    if (resolvedRelative.startsWith(`..${sep}`) || resolvedRelative === ".." || isAbsolute(resolvedRelative)) return [`${code}_OUTSIDE_REPOSITORY`];
    return digest(await readFile(candidate)) === reference.sha256 ? [] : [`${code}_DIGEST_MISMATCH`];
  } catch {
    return [`${code}_MISSING`];
  }
}

export async function verifyDeploymentProvenance({ repositoryRoot = defaultRoot, manifestPath, approvalPath, now = new Date() }) {
  const findings = [];
  let manifest;
  let approval;
  let approvalBytes;
  try { manifest = JSON.parse(await readFile(manifestPath, "utf8")); } catch { findings.push("MANIFEST_UNREADABLE"); }
  try { approvalBytes = await readFile(approvalPath); approval = JSON.parse(approvalBytes.toString("utf8")); } catch { findings.push("APPROVAL_UNREADABLE"); }
  if (!manifest || !approval) return Object.freeze({ ok: false, findings: Object.freeze(findings.sort()) });
  findings.push(...validateDeploymentRecords(manifest, approval, now));
  if (manifest.approvalSha256 !== digest(approvalBytes)) findings.push("APPROVAL_FILE_DIGEST_MISMATCH");

  const head = git(repositoryRoot, ["rev-parse", "HEAD"]);
  if (head.status !== 0 || !commitPattern.test(head.stdout.trim())) findings.push("SOURCE_HEAD_UNAVAILABLE");
  else if (head.stdout.trim() !== manifest.source?.commit) findings.push("SOURCE_HEAD_MISMATCH");
  if (commitPattern.test(manifest.rollback?.sourceCommit)
    && git(repositoryRoot, ["cat-file", "-e", `${manifest.rollback.sourceCommit}^{commit}`]).status !== 0) {
    findings.push("ROLLBACK_SOURCE_UNAVAILABLE");
  }
  const status = git(repositoryRoot, ["status", "--porcelain=v1", "--untracked-files=all"]);
  if (status.status !== 0) findings.push("SOURCE_STATUS_UNAVAILABLE");
  else if (status.stdout.trim() !== "") findings.push("SOURCE_WORKTREE_DIRTY");

  const references = [
    [manifest.plan, "PLAN_EVIDENCE"],
    [manifest.providerLock, "PROVIDER_LOCK"],
    [manifest.configuration, "CONFIGURATION"],
    ...(Array.isArray(manifest.artifacts) ? manifest.artifacts.flatMap((artifact) => artifact && typeof artifact === "object"
      ? [[artifact.sbom, `SBOM:${artifact.name}`], [artifact.buildProvenance, `BUILD_PROVENANCE:${artifact.name}`]]
      : []) : []),
  ];
  for (const [reference, code] of references) findings.push(...await verifyEvidenceFile(repositoryRoot, reference, code));

  for (const [reference, code] of [[manifest.providerLock, "PROVIDER_LOCK"], [manifest.configuration, "CONFIGURATION"]]) {
    if (!reference || typeof reference.path !== "string") continue;
    if (git(repositoryRoot, ["ls-files", "--error-unmatch", "--", reference.path]).status !== 0) findings.push(`${code}_NOT_TRACKED`);
  }
  if (manifest.plan?.path && git(repositoryRoot, ["ls-files", "--error-unmatch", "--", manifest.plan.path]).status === 0) findings.push("SAVED_PLAN_MUST_NOT_BE_TRACKED");

  const unique = [...new Set(findings)].sort();
  return Object.freeze({ ok: unique.length === 0, findings: Object.freeze(unique) });
}

function argumentsFrom(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!["--manifest", "--approval", "--repository"].includes(key) || value === undefined) throw new Error("USAGE");
    result[key.slice(2)] = value;
  }
  if (!result.manifest || !result.approval) throw new Error("USAGE");
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = argumentsFrom(process.argv.slice(2));
    const report = await verifyDeploymentProvenance({
      repositoryRoot: resolve(args.repository ?? defaultRoot),
      manifestPath: resolve(args.manifest),
      approvalPath: resolve(args.approval),
    });
    if (!report.ok) {
      for (const finding of report.findings) process.stderr.write(`${finding}\n`);
      process.exitCode = 1;
    } else {
      process.stdout.write("deployment provenance verified\n");
    }
  } catch {
    process.stderr.write("usage: node scripts/verify-deployment-provenance.mjs --manifest PATH --approval PATH [--repository PATH]\n");
    process.exitCode = 2;
  }
}
