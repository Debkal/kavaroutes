import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { readMigrations } from "./migration-lib.mjs";

const SCHEMAS = ["platform", "intake", "fleet", "dispatch", "execution", "realtime", "billing", "integration", "audit", "outbox", "notification"];

// Constructs every migration set must contain somewhere. `set_config` is
// deliberately absent: tenant context is opened by the application in
// `withTenantTransaction` (packages/postgres-persistence/src/repositories.ts)
// with a transaction-local `set_config('app.tenant_id', $1, true)`, never by a
// migration. The previous list named it and then skipped it
// (`if (required === "set_config") continue;`), so that entry could not fail and
// the list overstated what this lint enforces. It is removed, not reworded.
const MANDATORY_CONSTRUCTS = ["postgis", "btree_gist", "FORCE ROW LEVEL SECURITY", "NOBYPASSRLS", "PARTITION BY RANGE", "EXCLUDE USING gist", "assert_tenant_boundaries"];

// Every `CREATE POLICY` must carry both a `USING` predicate and a `WITH CHECK`
// predicate. `USING` alone governs reads and the rows an UPDATE may target but
// leaves inserts unconstrained, so a tenant policy without `WITH CHECK` silently
// stops being a tenant boundary for writes.
export function policiesMissingWithCheck(sql) {
  const statements = [...sql.matchAll(/CREATE POLICY[\s\S]*?;/gi)].map((match) => match[0]);
  return {
    statements: statements.length,
    incomplete: statements.filter((statement) => !/USING\s*\(/i.test(statement) || !/WITH CHECK\s*\(/i.test(statement))
      .map((statement) => statement.replace(/\s+/g, " ").slice(0, 120)),
  };
}

// A `SECURITY DEFINER` function runs with its owner's rights, so an unset
// `search_path` lets a caller-controlled schema resolve the names inside the
// body (privilege escalation through search_path hijacking). The declaration
// (not the body) has to carry `SET search_path = …`. Both dollar-quote styles in
// use here are handled by taking the function header up to its first
// dollar-quoted body opener.
export function securityDefinerFunctionsWithoutSearchPath(sql) {
  const headers = [...sql.matchAll(/CREATE (?:OR REPLACE )?FUNCTION\s+([a-z_][a-z0-9_]*\.[a-z0-9_]+)/gi)].map((match) => {
    const rest = sql.slice(match.index);
    const bodyStart = rest.search(/\$[a-z_]*\$/i);
    return { name: match[1], header: bodyStart === -1 ? rest.slice(0, 4096) : rest.slice(0, bodyStart) };
  });
  return {
    functions: headers.length,
    offending: headers.filter(({ header }) => /\bSECURITY DEFINER\b/i.test(header) && !/SET\s+search_path\s*=/i.test(header)).map(({ name }) => name),
  };
}

export function lintMigrations(migrations) {
  assert.ok(migrations.length >= 7, "at least seven ordered migrations are required");
  migrations.forEach((migration, index) => {
    assert.equal(migration.name.slice(0, 4), String(index + 1).padStart(4, "0"), `migration sequence gap at ${migration.name}`);
    assert.match(migration.sql, /^BEGIN;/);
    assert.match(migration.sql, /COMMIT;\s*$/);
    assert.doesNotMatch(migration.sql, /\b(latest|cloudsql|google maps|redis)\b/i);
  });

  const combined = migrations.map(({ sql }) => sql).join("\n");
  for (const schema of SCHEMAS) {
    assert.match(combined, new RegExp(`CREATE SCHEMA IF NOT EXISTS ${schema}\\b`));
  }
  for (const required of MANDATORY_CONSTRUCTS) {
    assert.ok(combined.includes(required), `missing mandatory migration construct: ${required}`);
  }
  assert.doesNotMatch(combined, /ON DELETE CASCADE/i, "material history must not cascade");

  const policies = policiesMissingWithCheck(combined);
  assert.ok(policies.statements > 0, "the CREATE POLICY scan matched no statement, so the WITH CHECK rule would be vacuous");
  assert.deepEqual(policies.incomplete, [], "every CREATE POLICY needs both USING and WITH CHECK");

  const definers = securityDefinerFunctionsWithoutSearchPath(combined);
  assert.ok(definers.functions > 0, "the CREATE FUNCTION scan matched no function, so the search_path rule would be vacuous");
  assert.deepEqual(definers.offending, [], "a SECURITY DEFINER function must pin its search_path");
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const migrations = await readMigrations();
  lintMigrations(migrations);
  process.stdout.write(`migration lint passed (${migrations.length} immutable SQL files)\n`);
}
