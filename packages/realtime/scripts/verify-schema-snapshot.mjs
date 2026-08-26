import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { withFreshDatabase } from "../../postgres-persistence/scripts/database-fixture.mjs";

const connectionString = process.env.WP009_DATABASE_URL ?? process.env.WP008_DATABASE_URL;
if (!connectionString) throw new Error("WP009_DATABASE_URL is required");
await withFreshDatabase(connectionString, "wp009_snapshot_verify", async (_pool, databaseUrl) => {
  process.stdout.write(execFileSync(process.execPath, [resolve(import.meta.dirname, "../../postgres-persistence/scripts/schema-snapshot.mjs")],
    { env: { ...process.env, WP006_DATABASE_URL: databaseUrl }, encoding: "utf8" }));
});
