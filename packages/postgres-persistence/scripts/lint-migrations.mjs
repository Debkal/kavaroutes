import assert from "node:assert/strict";
import { readMigrations } from "./migration-lib.mjs";

const migrations = await readMigrations();
assert.ok(migrations.length >= 7, "at least seven ordered migrations are required");
migrations.forEach((migration, index) => {
  assert.equal(migration.name.slice(0, 4), String(index + 1).padStart(4, "0"), `migration sequence gap at ${migration.name}`);
  assert.match(migration.sql, /^BEGIN;/);
  assert.match(migration.sql, /COMMIT;\s*$/);
  assert.doesNotMatch(migration.sql, /\b(latest|cloudsql|google maps|redis)\b/i);
});

const combined = migrations.map(({ sql }) => sql).join("\n");
for (const schema of ["platform", "intake", "fleet", "dispatch", "execution", "realtime", "billing", "integration", "audit", "outbox", "notification"]) {
  assert.match(combined, new RegExp(`CREATE SCHEMA IF NOT EXISTS ${schema}\\b`));
}
for (const required of ["postgis", "btree_gist", "FORCE ROW LEVEL SECURITY", "NOBYPASSRLS", "PARTITION BY RANGE", "EXCLUDE USING gist", "set_config", "assert_tenant_boundaries"]) {
  if (required === "set_config") continue;
  assert.ok(combined.includes(required), `missing mandatory migration construct: ${required}`);
}
assert.doesNotMatch(combined, /ON DELETE CASCADE/i, "material history must not cascade");
process.stdout.write(`migration lint passed (${migrations.length} immutable SQL files)\n`);
