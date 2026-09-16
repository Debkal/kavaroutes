import { readdir, readFile } from "node:fs/promises";
import { extname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const sourceRoots = [resolve(root, "apps"), resolve(root, "packages")];
const extensions = new Set([".ts", ".tsx", ".js", ".mjs"]);
const ownedLoggingAdapter = "apps/api-host/src/logging.ts";

const policies = Object.freeze([
  { code: "DIRECT_CONSOLE", pattern: /\bconsole\.(?:log|info|warn|error|debug|trace)\s*\(/ },
  { code: "DIRECT_PROCESS_OUTPUT", pattern: /\bprocess\.(?:stdout|stderr)\.write\s*\(/ },
  { code: "DIRECT_LOGGER", pattern: /\b(?:logger|request\.log|reply\.log|app\.log)\.(?:trace|debug|info|warn|error|fatal)\s*\(/ },
  { code: "DIRECT_PINO_IMPORT", pattern: /(?:from\s+["']pino["']|require\(["']pino["']\))/ },
]);

async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      if (["dist", "node_modules", "artifacts", "scripts", "test", "tests"].includes(entry.name)) return [];
      return sourceFiles(path);
    }
    return extensions.has(extname(entry.name)) ? [path] : [];
  }));
  return nested.flat();
}

export function unsafeLoggingFindings(path, source) {
  if (path === ownedLoggingAdapter) return [];
  return policies.filter(({ pattern }) => pattern.test(source)).map(({ code }) => Object.freeze({ path, code }));
}

export async function auditApplicationLogging() {
  const files = (await Promise.all(sourceRoots.map(sourceFiles))).flat().sort();
  const findings = [];
  for (const file of files) {
    const path = relative(root, file).replaceAll("\\", "/");
    findings.push(...unsafeLoggingFindings(path, await readFile(file, "utf8")));
  }
  return Object.freeze({ files: files.length, findings: Object.freeze(findings) });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = await auditApplicationLogging();
  if (report.findings.length > 0) {
    for (const finding of report.findings) process.stderr.write(`${finding.code}:${finding.path}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write(`safe logging check passed (${report.files} application source files)\n`);
  }
}
