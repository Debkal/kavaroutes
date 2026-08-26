import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { relative, resolve } from "node:path";

const repository = resolve(import.meta.dirname, "../../..");
const appRoot = resolve(repository, "apps/driver");
const expo = resolve(repository, "node_modules/.bin/expo");
const iosRoot = resolve(appRoot, "ios");
const exportRoot = resolve(appRoot, "dist/export-ios");
const bundleRoot = resolve(exportRoot, "_expo/static/js/ios");
const artifactRoot = resolve(repository, "builds/client/ios");

execFileSync(expo, ["prebuild", "--platform", "ios", "--no-install", "--clean"], { cwd: appRoot, env: process.env, stdio: "inherit" });
const xcodeProject = (await readdir(iosRoot)).find((name) => name.endsWith(".xcodeproj"));
assert.ok(xcodeProject, "Expo CNG did not produce an iOS Xcode project");
execFileSync(expo, ["export", "--platform", "ios", "--output-dir", exportRoot, "--clear"], { cwd: appRoot, env: process.env, stdio: "inherit" });
const bundleName = (await readdir(bundleRoot)).find((name) => name.endsWith(".hbc"));
assert.ok(bundleName, "Expo did not produce an iOS Hermes bundle");
const source = resolve(bundleRoot, bundleName);
const target = resolve(artifactRoot, "kavaroutes-driver-ios-hermes.hbc");
await mkdir(artifactRoot, { recursive: true });
await cp(source, target);
const content = await readFile(target);
const report = {
  format: 1,
  workPackage: "010",
  result: "PASS_IOS_HERMES_BUNDLE_CREATED",
  artifact: relative(repository, target),
  bytes: (await stat(target)).size,
  sha256: createHash("sha256").update(content).digest("hex"),
  bundleIdentifier: "com.kavaroutes.driver.synthetic",
  minimumIos: "16.4",
  generatedXcodeProject: relative(repository, resolve(iosRoot, xcodeProject)),
  cngProjectPrepared: true,
  developmentStatus: "DEFERRED_PENDING_MACOS_XCODE",
  installableBinary: false,
  xcodeBuildExecuted: false,
  podInstallExecuted: false,
  simulatorExecuted: false,
  physicalDeviceExecuted: false,
  externalUpload: false,
  nextRequirement: "iOS development resumes only when the human provides a macOS/Xcode test host",
};
await writeFile(resolve(repository, "packages/driver-core/artifacts/ios-bundle-report.json"), `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`WP010 iOS Hermes bundle created: ${relative(repository, target)} (${report.bytes} bytes; sha256 ${report.sha256})\n`);
