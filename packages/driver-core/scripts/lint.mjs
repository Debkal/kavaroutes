import assert from "node:assert/strict";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { driverSchemas, DRIVER_MIGRATIONS } from "../dist/index.js";

const root = resolve(import.meta.dirname, "..");
const repository = resolve(root, "../..");
const app = JSON.parse(await readFile(resolve(repository, "apps/driver/app.json"), "utf8"));
const manifest = JSON.parse(await readFile(resolve(repository, "apps/driver/package.json"), "utf8"));
assert.equal(manifest.dependencies.expo, "57.0.16"); assert.equal(manifest.dependencies["react-native"], "0.86.2"); assert.equal(manifest.dependencies.react, "19.2.3");
assert.equal(manifest.dependencies["react-native-reanimated"], "4.5.1"); assert.equal(manifest.dependencies["react-native-worklets"], "0.10.1");
assert.equal("newArchEnabled" in app.expo, false); assert.equal("jsEngine" in app.expo, false); assert.equal(app.expo.ios.bundleIdentifier, "com.kavaroutes.driver.synthetic");
for (const permission of ["android.permission.READ_MEDIA_IMAGES", "android.permission.RECORD_AUDIO", "android.permission.READ_EXTERNAL_STORAGE", "android.permission.WRITE_EXTERNAL_STORAGE",
  "android.permission.SYSTEM_ALERT_WINDOW", "android.permission.VIBRATE", "android.permission.USE_BIOMETRIC", "android.permission.USE_FINGERPRINT"]) assert.ok(app.expo.android.blockedPermissions.includes(permission));
assert.equal(app.expo.plugins.some((plugin) => Array.isArray(plugin) && plugin[0] === "expo-sqlite" && plugin[1].useSQLCipher === true), true);
assert.equal(app.expo.plugins.some((plugin) => Array.isArray(plugin) && plugin[0] === "expo-build-properties" && plugin[1].android.compileSdkVersion === 36 && plugin[1].android.targetSdkVersion === 36 && plugin[1].android.minSdkVersion === 29 && plugin[1].ios.deploymentTarget === "16.4"), true);
assert.equal(driverSchemas.length, 7); assert.equal(DRIVER_MIGRATIONS.length, 1);
const files = [];
async function walk(directory) { for (const item of await readdir(directory, { withFileTypes: true })) { const target = resolve(directory, item.name); if (item.isDirectory()) await walk(target); else if (/\.(ts|tsx)$/.test(item.name)) files.push(target); } }
await walk(resolve(repository, "apps/driver")); await walk(resolve(root, "src"));
const source = (await Promise.all(files.map((file) => readFile(file, "utf8")))).join("\n");
assert.doesNotMatch(source, /AsyncStorage|redux-persist|firebase|@googlemaps|eas update|segment|sentry|datadog/i);
assert.doesNotMatch(source, /@kavaroutes\/(postgres-persistence|durable-execution)|fastify|drizzle-orm|pg-boss/i);
assert.doesNotMatch(source, /from ["']node:/);
const background = await readFile(resolve(repository, "apps/driver/src/background-location.ts"), "utf8");
assert.match(background, /TaskManager\.defineTask/); assert.doesNotMatch(background, /fetch\(|upload|render|arrival|billing/i);
let routeSurfaceCount = 0;
async function countRoutes(directory) { for (const entry of await readdir(directory, { withFileTypes: true })) { if (entry.isDirectory()) await countRoutes(resolve(directory, entry.name));
  else if (entry.name.endsWith(".tsx") && !entry.name.startsWith("_")) routeSurfaceCount += 1; } }
await countRoutes(resolve(repository, "apps/driver/app"));
assert.equal(routeSurfaceCount, 10);
const report = { format: 1, result: "PASS", schemas: driverSchemas.length, migrations: DRIVER_MIGRATIONS.length, sourceFiles: files.length,
  expo: manifest.dependencies.expo, reactNative: manifest.dependencies["react-native"], react: manifest.dependencies.react, newArchitectureMandatoryBySdk57: true, hermesMandatoryBySdk57: true,
  sqlCipherConfigured: true, routeSurfaces: routeSurfaceCount, physicalDeviceEvidence: false, completionBlockedBy: "HIG-006" };
await writeFile(resolve(root, "artifacts/local-lint-report.json"), `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`WP010 local architecture/privacy lint passed (${files.length} source files; ${routeSurfaceCount} route surfaces)\n`);
