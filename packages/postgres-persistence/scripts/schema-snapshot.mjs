import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Pool } from "pg";
import { packageRoot } from "./migration-lib.mjs";

const connectionString = process.env.WP006_DATABASE_URL;
if (!connectionString) throw new Error("WP006_DATABASE_URL is required");
const expectedPath = resolve(packageRoot, "artifacts/schema-snapshot.json");
const pool = new Pool({ connectionString, max: 1, application_name: "kavaroutes-wp006-snapshot" });
const schemas = ["platform","intake","fleet","dispatch","execution","realtime","billing","integration","audit","outbox","notification"];
try {
  const tables = await pool.query(`SELECT n.nspname AS schema, c.relname AS table, c.relkind AS kind,
      c.relrowsecurity AS rls, c.relforcerowsecurity AS force_rls
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname = ANY($1) AND c.relkind IN ('r','p') ORDER BY 1,2`, [schemas]);
  const columns = await pool.query(`SELECT table_schema AS schema, table_name AS table, ordinal_position,
      column_name, data_type, udt_name, is_nullable
    FROM information_schema.columns WHERE table_schema = ANY($1) ORDER BY 1,2,3`, [schemas]);
  const constraints = await pool.query(`SELECT n.nspname AS schema, c.relname AS table, con.conname AS name,
      con.contype AS type, pg_get_constraintdef(con.oid, true) AS definition
    FROM pg_constraint con JOIN pg_class c ON c.oid=con.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname = ANY($1) ORDER BY 1,2,3`, [schemas]);
  const indexes = await pool.query(`SELECT schemaname AS schema, tablename AS table, indexname AS name, indexdef AS definition
    FROM pg_indexes WHERE schemaname = ANY($1) ORDER BY 1,2,3`, [schemas]);
  const policies = await pool.query(`SELECT schemaname AS schema, tablename AS table, policyname AS name, roles, qual, with_check
    FROM pg_policies WHERE schemaname = ANY($1) ORDER BY 1,2,3`, [schemas]);
  const functions = await pool.query(`SELECT n.nspname AS schema, p.proname AS name,
      pg_get_function_identity_arguments(p.oid) AS arguments, pg_get_functiondef(p.oid) AS definition
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname = ANY($1) ORDER BY 1,2,3`, [schemas]);
  const extensions = await pool.query("SELECT extname AS name, extversion AS version FROM pg_extension WHERE extname IN ('postgis','btree_gist','pg_stat_statements') ORDER BY 1");
  const roles = await pool.query("SELECT rolname AS name, rolsuper, rolcreaterole, rolcreatedb, rolcanlogin, rolinherit, rolbypassrls FROM pg_roles WHERE rolname LIKE 'kavaroutes_%' ORDER BY 1");
  const snapshot = { tables: tables.rows, columns: columns.rows, constraints: constraints.rows, indexes: indexes.rows, policies: policies.rows, functions: functions.rows, extensions: extensions.rows, roles: roles.rows };
  const canonical = JSON.stringify(snapshot);
  const actual = {
    format: 1,
    sha256: createHash("sha256").update(canonical).digest("hex"),
    counts: Object.fromEntries(Object.entries(snapshot).map(([name, rows]) => [name, rows.length])),
    extensions: extensions.rows,
  };
  if (process.argv.includes("--print")) {
    process.stdout.write(`${JSON.stringify(actual, null, 2)}\n`);
  } else {
    const expected = JSON.parse(await readFile(expectedPath, "utf8"));
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error(`SCHEMA_DRIFT:${JSON.stringify({ expected, actual })}`);
    }
    process.stdout.write(`schema snapshot passed (${actual.sha256})\n`);
  }
} finally {
  await pool.end();
}
