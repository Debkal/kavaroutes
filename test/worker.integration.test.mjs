import assert from "node:assert/strict";
import test from "node:test";
import { PgBoss } from "pg-boss";
import { Pool } from "pg";

const connectionString = process.env.TEST_DATABASE_URL;
if (!connectionString) throw new Error("TEST_DATABASE_URL is required; start infra/wp005/compose.yaml first");

const queue = "wp005-atomic-probe";
const payload = { probeId: "probe_3333cccc", operationId: "op_worker_test_001" };

test("pg-boss enrollment shares a transaction, deduplicates, exposes failure, and shuts down", { timeout: 30_000 }, async () => {
  const pool = new Pool({ connectionString, max: 3, application_name: "kavaroutes-wp005-worker-test" });
  const boss = new PgBoss({ connectionString, schema: "wp005_boss", supervise: false, schedule: false });
  boss.on("error", () => {});
  try {
    await pool.query("CREATE SCHEMA IF NOT EXISTS wp005_test");
    await pool.query("CREATE TABLE IF NOT EXISTS wp005_test.atomic_marker (id text PRIMARY KEY)");
    await pool.query("TRUNCATE wp005_test.atomic_marker");
    await boss.start();
    await boss.createQueue(queue);
    await boss.deleteAllJobs(queue);

    const transaction = await pool.connect();
    let rolledBackJobId;
    try {
      await transaction.query("BEGIN");
      await transaction.query("INSERT INTO wp005_test.atomic_marker(id) VALUES ('rollback')");
      const db = { executeSql: async (text, values) => transaction.query(text, values) };
      rolledBackJobId = await boss.send(queue, payload, { db, singletonKey: "rollback-key", singletonSeconds: 86_400, retryLimit: 0 });
      await transaction.query("ROLLBACK");
    } finally {
      transaction.release();
    }
    assert.equal((await pool.query("SELECT count(*)::int AS count FROM wp005_test.atomic_marker WHERE id = 'rollback'")).rows[0].count, 0);
    assert.deepEqual(await boss.findJobs(queue, { id: rolledBackJobId }), []);

    const committed = await pool.connect();
    let committedJobId;
    try {
      await committed.query("BEGIN");
      await committed.query("INSERT INTO wp005_test.atomic_marker(id) VALUES ('commit')");
      const db = { executeSql: async (text, values) => committed.query(text, values) };
      committedJobId = await boss.send(queue, payload, { db, singletonKey: "commit-key", singletonSeconds: 86_400, retryLimit: 0 });
      await committed.query("COMMIT");
    } finally {
      committed.release();
    }
    assert.equal((await pool.query("SELECT count(*)::int AS count FROM wp005_test.atomic_marker WHERE id = 'commit'")).rows[0].count, 1);
    assert.equal((await boss.findJobs(queue, { id: committedJobId })).length, 1);
    assert.equal(await boss.send(queue, payload, { singletonKey: "commit-key", singletonSeconds: 86_400, retryLimit: 0 }), null);

    const failedId = await boss.send(queue, payload, { singletonKey: "failure-key", singletonSeconds: 86_400, retryLimit: 0 });
    const retryId = await boss.send(queue, payload, {
      singletonKey: "retry-key",
      singletonSeconds: 86_400,
      retryLimit: 2,
      retryDelay: 1
    });
    let observedFailure = false;
    let retryAttempts = 0;
    await boss.work(queue, { pollingIntervalSeconds: 0.5 }, async ([job]) => {
      if (job?.id === failedId) {
        observedFailure = true;
        throw new Error("SYNTHETIC_RETRY_FAILURE");
      }
      if (job?.id === retryId) {
        retryAttempts += 1;
        if (retryAttempts === 1) throw new Error("SYNTHETIC_RETRY_ONCE");
      }
    });
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const failedJobs = await boss.findJobs(queue, { id: failedId });
      const retriedJobs = await boss.findJobs(queue, { id: retryId });
      if (failedJobs[0]?.state === "failed" && retriedJobs[0]?.state === "completed") break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(observedFailure, true);
    assert.equal((await boss.findJobs(queue, { id: failedId }))[0]?.state, "failed");
    assert.equal(retryAttempts, 2);
    assert.equal((await boss.findJobs(queue, { id: retryId }))[0]?.state, "completed");
  } finally {
    await boss.stop({ graceful: true, timeout: 5_000 });
    await pool.query("DROP SCHEMA IF EXISTS wp005_test CASCADE");
    await pool.end();
  }
});
