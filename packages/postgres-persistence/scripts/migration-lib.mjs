import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const migrationsDirectory = resolve(packageRoot, "migrations");

export async function readMigrations() {
  const names = (await readdir(migrationsDirectory))
    .filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/.test(name))
    .sort();
  return Promise.all(names.map(async (name) => {
    const sql = await readFile(resolve(migrationsDirectory, name), "utf8");
    return { name, sql, checksum: createHash("sha256").update(sql).digest("hex") };
  }));
}

export async function applyMigrations(client) {
  await client.query("SELECT pg_advisory_lock(hashtext('kavaroutes-wp006-migrations'))");
  try {
    await client.query(`CREATE TABLE IF NOT EXISTS public.kavaroutes_schema_migration (
      migration_name text PRIMARY KEY,
      sha256 text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const applied = await client.query("SELECT migration_name, sha256 FROM public.kavaroutes_schema_migration ORDER BY migration_name");
    const appliedByName = new Map(applied.rows.map((row) => [row.migration_name, row.sha256]));
    const migrations = await readMigrations();
    for (const migration of migrations) {
      const recorded = appliedByName.get(migration.name);
      if (recorded && recorded !== migration.checksum) {
        throw new Error(`MIGRATION_CHECKSUM_MISMATCH:${migration.name}`);
      }
      if (!recorded) {
        await client.query(migration.sql);
        await client.query(
          "INSERT INTO public.kavaroutes_schema_migration (migration_name, sha256) VALUES ($1, $2)",
          [migration.name, migration.checksum],
        );
      }
    }
    return migrations;
  } finally {
    await client.query("SELECT pg_advisory_unlock(hashtext('kavaroutes-wp006-migrations'))");
  }
}
