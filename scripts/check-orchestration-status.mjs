import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function section(document, heading) {
  const start = document.indexOf(heading);
  if (start < 0) return "";
  const next = document.indexOf("\n## ", start + heading.length);
  return document.slice(start, next < 0 ? undefined : next);
}

function requireTerms(findings, code, value, terms) {
  if (terms.some((term) => !value.includes(term))) findings.push(code);
}

function statusLine(value) {
  return value.split("\n").find((line) => line.startsWith("**Status:**")) ?? "";
}

export function auditOrchestrationStatus(documents) {
  const findings = [];
  const plan010 = section(documents.plan, "## Builder Work Package 010");
  const plan011 = section(documents.plan, "## Builder Work Package 011");
  const plan012 = section(documents.plan, "## Builder Work Package 012");
  const plan013 = section(documents.plan, "## Builder Work Package 013");
  const hig002 = section(documents.human, "## HIG-002");
  const hig006 = section(documents.human, "## HIG-006");
  const hig013 = section(documents.human, "## HIG-013");

  requireTerms(findings, "PLAN_WP010_STATUS_DRIFT", plan010, ["**Status:** **Complete", "Android", "iOS", "deferred"]);
  requireTerms(findings, "PLAN_WP011_STATUS_DRIFT", plan011, ["**Status:** **Complete."]);
  requireTerms(findings, "PLAN_WP012_STATUS_DRIFT", plan012, ["**Status:** **Blocked at HIG-013", "local fake-provider phase"]);
  requireTerms(findings, "PLAN_WP013_GATE_DRIFT", statusLine(plan013), ["Active cloud preparation", "2026-09-11", "WP012 remains blocked at HIG-013", "Maps and push disabled", "HIG-002"]);
  requireTerms(findings, "HUMAN_HIG002_STATUS_DRIFT", hig002, ["**Preparation active; deployment pending.", "billing enabled", "explicitly authorized", "No VM has been created"]);
  requireTerms(findings, "HUMAN_HIG006_STATUS_DRIFT", hig006, ["WP010 is complete", "Android", "iOS remains explicitly deferred"]);
  requireTerms(findings, "HUMAN_HIG013_STATUS_DRIFT", hig013, ["**Not triggered", "local", "complete", "Final WP012 is blocked"]);
  requireTerms(findings, "BUILDER_WP012_STATUS_DRIFT", documents.builderStatus, ["WP012", "| Blocked |", "local fake-provider foundation passes"]);
  requireTerms(findings, "QA_WP012_STATUS_DRIFT", documents.qa, ["WP012 completed its local fake-provider stage and is blocked at HIG-013"]);
  requireTerms(findings, "GUIDE_WP012_STATUS_DRIFT", documents.guide, ["The local WP012 push foundation has passed", "WP012 is now blocked at **HIG-013**"]);
  requireTerms(findings, "MEMORY_WP012_STATUS_DRIFT", documents.memory, ["WP012 completed its local fake-provider phase and is blocked at HIG-013"]);

  return Object.freeze([...new Set(findings)].sort());
}

export async function readOrchestrationDocuments(repositoryRoot = root) {
  const entries = await Promise.all(Object.entries({
    plan: "plan.md",
    human: "human.md",
    builderStatus: "builder_status.md",
    qa: "qa.md",
    guide: "stepbystephuman.md",
    memory: "memories.md",
  }).map(async ([name, path]) => [name, await readFile(resolve(repositoryRoot, path), "utf8")]));
  return Object.freeze(Object.fromEntries(entries));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const findings = auditOrchestrationStatus(await readOrchestrationDocuments());
  if (findings.length > 0) {
    for (const finding of findings) process.stderr.write(`${finding}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write("orchestration status check passed (WP010-WP013 and HIG-002/HIG-006/HIG-013)\n");
  }
}
