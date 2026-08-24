import { Pool } from "pg";
import { applyMigrations } from "./migration-lib.mjs";

const connectionString = process.env.WP006_DATABASE_URL;
if (!connectionString) throw new Error("WP006_DATABASE_URL is required");

const pool = new Pool({ connectionString, max: 1, application_name: "kavaroutes-wp006-migrate" });
try {
  const client = await pool.connect();
  try {
    const { rows: [version] } = await client.query("SHOW server_version");
    if (!version.server_version.startsWith("17.")) {
      throw new Error(`UNREVIEWED_POSTGRES_MAJOR:${version.server_version}`);
    }
    const migrations = await applyMigrations(client);
    const { rows: [postgis] } = await client.query("SELECT postgis_full_version() AS version");
    process.stdout.write(`${JSON.stringify({ migrations: migrations.map(({ name, checksum }) => ({ name, checksum })), postgres: version.server_version, postgis: postgis.version }, null, 2)}\n`);
  } finally {
    client.release();
  }
} finally {
  await pool.end();
}
