import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const artifacts = path.join(root, "artifacts");
const resultsPath = path.join(root, "test-results", "playwright-results.json");

// Every field below is read back from the Playwright JSON reporter, so the
// retained artifact describes the run that actually happened. Anything the
// reporter does not emit (engine versions, for example) is recorded as a
// limitation instead of being asserted.
function bucket(status) {
  if (status === "passed" || status === "expected") return "passed";
  if (status === "skipped") return "skipped";
  if (status === "failed" || status === "timedOut" || status === "interrupted") return "failed";
  return "notRun";
}

function collectSuites(suite, visit) {
  for (const spec of suite.specs ?? []) visit(spec);
  for (const child of suite.suites ?? []) collectSuites(child, visit);
}

let report;
try {
  report = JSON.parse(await readFile(resultsPath, "utf8"));
} catch (error) {
  console.error(
    `browser report: ${resultsPath} is unreadable (${error.code ?? error.message}); refusing to attest a browser run that recorded no results`,
  );
  process.exit(1);
}

const projects = new Map();
const totals = { tests: 0, passed: 0, failed: 0, skipped: 0, notRun: 0 };
const browsers = new Set();

for (const suite of report.suites ?? []) {
  collectSuites(suite, (spec) => {
    for (const test of spec.tests ?? []) {
      const name = test.projectName ?? test.projectId ?? "unknown";
      const entry = projects.get(name) ?? { name, tests: 0, passed: 0, failed: 0, skipped: 0, notRun: 0 };
      const last = (test.results ?? []).at(-1);
      const outcome = last ? bucket(last.status) : "notRun";
      entry.tests += 1;
      entry[outcome] += 1;
      projects.set(name, entry);
      totals.tests += 1;
      totals[outcome] += 1;
      const [browser] = name.split("-");
      if (browser) browsers.add(browser);
    }
  });
}

const result =
  totals.passed > 0 && totals.failed === 0 && totals.notRun === 0 ? "PASS" : "INCOMPLETE";

const artifact = {
  schemaVersion: 2,
  generatedAt: new Date().toISOString(),
  source: {
    commit: process.env.GITHUB_SHA ?? null,
    workflowRun: process.env.GITHUB_RUN_ID ?? null,
    image: process.env.KR_BROWSER_IMAGE ?? null,
  },
  runner: `Playwright ${report.config?.version ?? "unknown"} JSON reporter`,
  result,
  tests: totals.tests,
  executed: totals.passed + totals.failed,
  passed: totals.passed,
  failed: totals.failed,
  skipped: totals.skipped,
  notRun: totals.notRun,
  browsers: [...browsers].sort(),
  projects: [...projects.values()].sort((left, right) => left.name.localeCompare(right.name)),
  accessibility:
    "axe-core automation and the keyboard-focus, command-dialog and document-reflow assertions in apps/web/test/browser/operations.spec.ts executed; branded-Safari, VoiceOver, NVDA and JAWS UAT are not claimed",
  limitations: [
    "engine versions are not emitted by the Playwright JSON reporter and are therefore not asserted here",
    "the browser build is pinned by the container image recorded in source.image",
  ],
};

await mkdir(artifacts, { recursive: true });
await writeFile(path.join(artifacts, "browser-report.json"), `${JSON.stringify(artifact, null, 2)}\n`);
console.log(
  `browser report: ${result} — ${totals.passed}/${totals.tests} passed, ${totals.failed} failed, ${totals.skipped} skipped, ${totals.notRun} without a recorded result`,
);
if (result !== "PASS") process.exit(1);
