import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { basename, relative, resolve } from "node:path";

const repository = resolve(import.meta.dirname, "../../..");
const appRoot = resolve(repository, "apps/driver");
const androidRoot = resolve(appRoot, "android");
const tooling = resolve(repository, ".tooling");
const javaHome = resolve(tooling, "jdk-17");
const sdkRoot = resolve(tooling, "android-sdk");
const buildTools = resolve(sdkRoot, "build-tools/36.0.0");
const expo = resolve(repository, "node_modules/.bin/expo");
const artifactRoot = resolve(repository, "builds/client/android");
const apk = resolve(artifactRoot, "kavaroutes-driver-android.apk");
const reportPath = resolve(repository, "packages/driver-core/artifacts/android-apk-report.json");

for (const required of [resolve(javaHome, "bin/java"), resolve(sdkRoot, "platform-tools/adb"), resolve(buildTools, "apksigner"), expo]) {
  assert.ok((await stat(required)).isFile(), `missing required local tool: ${required}`);
}

const sourceFiles = [];
async function collect(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = resolve(directory, entry.name);
    if (entry.isDirectory()) await collect(target);
    else if (/\.(json|mjs|sql|ts|tsx)$/.test(entry.name)) sourceFiles.push(target);
  }
}
for (const directory of [resolve(appRoot, "app"), resolve(appRoot, "src"), resolve(repository, "packages/driver-core/src"), resolve(repository, "packages/realtime/src"), resolve(repository, "packages/api-contracts/src")]) await collect(directory);
for (const file of [resolve(appRoot, "app.json"), resolve(appRoot, "package.json"), resolve(repository, "package.json"), resolve(repository, "package-lock.json")]) sourceFiles.push(file);
sourceFiles.sort();
const sourceDigest = createHash("sha256");
for (const file of sourceFiles) sourceDigest.update(`${relative(repository, file)}\0`).update(await readFile(file)).update("\0");

const env = {
  ...process.env,
  ANDROID_HOME: sdkRoot,
  ANDROID_SDK_ROOT: sdkRoot,
  GRADLE_USER_HOME: resolve(tooling, "gradle"),
  JAVA_HOME: javaHome,
  NODE_ENV: "production",
  PATH: `${resolve(javaHome, "bin")}:${resolve(sdkRoot, "platform-tools")}:${resolve(repository, ".tooling/node-v24.19.0-linux-x64/bin")}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
};

execFileSync(expo, ["prebuild", "--platform", "android", "--no-install", "--clean"], { cwd: appRoot, env, stdio: "inherit" });
await writeFile(resolve(androidRoot, "local.properties"), `sdk.dir=${sdkRoot}\n`);
execFileSync(resolve(androidRoot, "gradlew"), ["app:assembleRelease", "--no-daemon", "--stacktrace"], { cwd: androidRoot, env, stdio: "inherit" });

const builtApk = resolve(androidRoot, "app/build/outputs/apk/release/app-release.apk");
await mkdir(artifactRoot, { recursive: true });
await cp(builtApk, apk);
const bytes = (await stat(apk)).size;
const sha256 = createHash("sha256").update(await readFile(apk)).digest("hex");
execFileSync(resolve(buildTools, "zipalign"), ["-c", "-P", "16", "-v", "4", apk], { env, stdio: "pipe" });
const signer = execFileSync(resolve(buildTools, "apksigner"), ["verify", "--verbose", "--print-certs", apk], { env, encoding: "utf8" });
assert.match(signer, /Verified using v2 scheme \(APK Signature Scheme v2\): true/);
assert.match(signer, /CN=Android Debug/);
const badging = execFileSync(resolve(buildTools, "aapt"), ["dump", "badging", apk], { env, encoding: "utf8" });
assert.match(badging, /package: name='com\.kavaroutes\.driver\.synthetic'/);
assert.match(badging, /sdkVersion:'29'/);
assert.match(badging, /targetSdkVersion:'36'/);
assert.doesNotMatch(badging, /application-debuggable/);
const permissionDump = execFileSync(resolve(buildTools, "aapt"), ["dump", "permissions", apk], { env, encoding: "utf8" });
const permissions = [...permissionDump.matchAll(/uses-permission: name='([^']+)'/g)].map((match) => match[1]).sort();
for (const permission of ["android.permission.ACCESS_BACKGROUND_LOCATION", "android.permission.ACCESS_COARSE_LOCATION", "android.permission.ACCESS_FINE_LOCATION",
  "android.permission.FOREGROUND_SERVICE", "android.permission.FOREGROUND_SERVICE_LOCATION", "android.permission.INTERNET", "android.permission.ACCESS_NETWORK_STATE",
  "android.permission.DETECT_SCREEN_CAPTURE", "android.permission.CAMERA"]) assert.ok(permissions.includes(permission), `required permission missing: ${permission}`);
for (const permission of ["android.permission.READ_MEDIA_IMAGES", "android.permission.RECORD_AUDIO", "android.permission.READ_EXTERNAL_STORAGE", "android.permission.WRITE_EXTERNAL_STORAGE",
  "android.permission.SYSTEM_ALERT_WINDOW", "android.permission.VIBRATE", "android.permission.USE_BIOMETRIC", "android.permission.USE_FINGERPRINT"]) assert.ok(!permissions.includes(permission), `prohibited permission present: ${permission}`);
const certificateDigest = signer.match(/Signer #1 certificate SHA-256 digest: ([a-f0-9]+)/i)?.[1];
assert.ok(certificateDigest);
const report = {
  format: 1,
  workPackage: "010",
  result: "PASS_DEVELOPMENT_APK_CREATED",
  artifact: relative(repository, apk),
  artifactName: basename(apk),
  bytes,
  sha256,
  packageName: "com.kavaroutes.driver.synthetic",
  versionName: "0.0.0-wp010",
  minimumAndroidApi: 29,
  targetAndroidApi: 36,
  permissions,
  sourceDigest: sourceDigest.digest("hex"),
  signing: { kind: "generated Android debug certificate", certificateSha256: certificateDigest, production: false },
  zipAligned: true,
  externalUpload: false,
  physicalInstallExecuted: false,
  adbAccessExecuted: false,
  permittedUse: "approved synthetic non-PHI WP010 physical-device feasibility only",
};
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`WP010 Android development APK created: ${relative(repository, apk)} (${bytes} bytes; sha256 ${sha256})\n`);
