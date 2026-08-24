import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { applyMigrations } from "./migration-lib.mjs";

export async function withFreshDatabase(connectionString, label, operation, beforeMigrate) {
  const source = new URL(connectionString);
  const databaseName = `wp006_${label}_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const controlUrl = new URL(source);
  controlUrl.pathname = "/postgres";
  const control = new Pool({ connectionString: controlUrl.toString(), max: 1 });
  await control.query(`CREATE DATABASE ${databaseName}`);
  const databaseUrl = new URL(source);
  databaseUrl.pathname = `/${databaseName}`;
  const pool = new Pool({ connectionString: databaseUrl.toString(), max: 12, application_name: `kavaroutes-${label}` });
  try {
    if (beforeMigrate) await beforeMigrate(pool);
    const client = await pool.connect();
    try {
      await applyMigrations(client);
    } finally {
      client.release();
    }
    return await operation(pool, databaseUrl.toString());
  } finally {
    await pool.end();
    await control.query(`DROP DATABASE ${databaseName}`);
    await control.end();
  }
}
