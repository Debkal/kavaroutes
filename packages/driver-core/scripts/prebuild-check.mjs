import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { tmpdir } from "node:os";

const root = resolve(import.meta.dirname, "../../..");
const appRoot = resolve(root, "apps/driver");
const expo = resolve(root, "node_modules/.bin/expo");
const extensions = /\.(xml|gradle|properties|json|plist|pbxproj|entitlements|kt|swift)$/;
const normalize = (relative, content) => relative.endsWith("project.pbxproj") ? content.replaceAll(/[A-F0-9]{24}/g, "<PBX_OBJECT_ID>") : content;

async function collect(directory, base = directory, result = new Map()) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = resolve(directory, entry.name);
    if (entry.isDirectory()) await collect(target, base, result);
    else if (extensions.test(entry.name)) {
      const relative = target.slice(base.length + 1).replaceAll("\\", "/");
      const content = normalize(relative, await readFile(target, "utf8"));
      result.set(relative, createHash("sha256").update(content).digest("hex"));
    }
  }
  return result;
}

async function generate(label) {
  const directory = await mkdtemp(resolve(tmpdir(), `kavaroutes-wp010-cng-${label}-`));
  await cp(resolve(appRoot, "app.json"), resolve(directory, "app.json"));
  await cp(resolve(appRoot, "package.json"), resolve(directory, "package.json"));
  await mkdir(resolve(directory, "app"));
  await writeFile(resolve(directory, "app/index.tsx"), "export default function SyntheticEntry() { return null; }\n");
  await symlink(resolve(root, "node_modules"), resolve(directory, "node_modules"), "dir");
  try {
    execFileSync(expo, ["prebuild", "--platform", "all", "--no-install", "--clean"], { cwd: directory, stdio: "pipe", env: process.env });
    const files = await collect(directory);
    const combined = (await Promise.all([...files.keys()].sort().map(async (file) => `${file}\n${normalize(file, await readFile(resolve(directory, file), "utf8"))}`))).join("\n");
    return { files, combined };
  } finally { await rm(directory, { recursive: true, force: true }); }
}

const first = await generate("a");
const second = await generate("b");
assert.deepEqual(first.files, second.files, "CNG output must be deterministic across clean generations");
for (const token of ["android.permission.ACCESS_BACKGROUND_LOCATION", "android.permission.FOREGROUND_SERVICE_LOCATION", "newArchEnabled=true", "hermesEnabled=true",
  "expo.sqlite.useSQLCipher=true", "android.minSdkVersion=29", "UIBackgroundModes", "location", "16.4", "KavaRoutes Driver to record synthetic route position"]) assert.match(first.combined, new RegExp(token.replaceAll(".", "\\.")));
assert.doesNotMatch(first.combined, /google-services\.json|GoogleService-Info\.plist|api[_-]?key|patient|rider_name/i);
const digest = createHash("sha256").update([...first.files.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([file, hash]) => `${file}:${hash}`).join("\n")).digest("hex");
const report = { format: 1, result: "PASS", generatedTwice: true, deterministic: true, files: first.files.size, digest, platform: ["android", "ios"],
  compileTargetSdk: 36, minimumAndroid: 29, minimumIos: "16.4", newArchitecture: true, hermes: true, sqlCipher: true,
  normalization: "Xcode 24-character project object identifiers only", physicalBuildExecuted: false, completionBlockedBy: "HIG-006" };
await writeFile(resolve(import.meta.dirname, "../artifacts/native-config-report.json"), `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`WP010 deterministic Android/iOS CNG check passed (${first.files.size} native config files; ${digest})\n`);
