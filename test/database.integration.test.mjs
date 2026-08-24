import assert from "node:assert/strict";
import test from "node:test";
import { Pool } from "pg";
import { createPostgresProbeAdapter } from "@kavaroutes/platform-engine/adapters";
import { acceptSyntheticProbe } from "@kavaroutes/platform-engine/domain";
import { syntheticContext } from "@kavaroutes/platform-test-support";

const connectionString = process.env.TEST_DATABASE_URL;
if (!connectionString) throw new Error("TEST_DATABASE_URL is required; start infra/wp005/compose.yaml first");

test("Drizzle/PostgreSQL/PostGIS harness proves connection, commit, rollback, extension, and cleanup", async () => {
  const pool = new Pool({ connectionString, max: 2, application_name: "kavaroutes-wp005-test" });
  try {
    await pool.query("CREATE EXTENSION IF NOT EXISTS postgis");
    await pool.query("DROP SCHEMA IF EXISTS wp005_test CASCADE");
    await pool.query("CREATE SCHEMA wp005_test");
    await pool.query(`CREATE TABLE wp005_test.synthetic_probe (
      id text PRIMARY KEY,
      tenant_placeholder text NOT NULL,
      input text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    )`);
    const extension = await pool.query("SELECT extversion FROM pg_extension WHERE extname = 'postgis'");
    assert.equal(extension.rowCount, 1);

    const adapter = createPostgresProbeAdapter(pool);
    await adapter.save(syntheticContext(), acceptSyntheticProbe("probe_1111aaaa", "alpha"));
    assert.equal((await pool.query("SELECT count(*)::int AS count FROM wp005_test.synthetic_probe")).rows[0].count, 1);

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("INSERT INTO wp005_test.synthetic_probe(id, tenant_placeholder, input) VALUES ($1, $2, $3)", ["probe_2222bbbb", "tenant_synthetic", "bravo"]);
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
    assert.equal((await pool.query("SELECT count(*)::int AS count FROM wp005_test.synthetic_probe WHERE id = 'probe_2222bbbb'")).rows[0].count, 0);
  } finally {
    await pool.query("DROP SCHEMA IF EXISTS wp005_test CASCADE");
    await pool.end();
  }
});
