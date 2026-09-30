import assert from "node:assert/strict";
import test from "node:test";
import { auditOrchestrationStatus, readOrchestrationDocuments } from "../scripts/check-orchestration-status.mjs";

test("current package and human-gate status is consistent across owned records", async () => {
  assert.deepEqual(auditOrchestrationStatus(await readOrchestrationDocuments()), []);
});

test("status audit detects a stale WP012 human-gate description", async () => {
  const documents = await readOrchestrationDocuments();
  const stale = {
    ...documents,
    human: documents.human.replace(
      "Final WP012 is blocked here because it cannot pass",
      "WP012 has not started and may later run"
    ),
  };
  assert.ok(auditOrchestrationStatus(stale).includes("HUMAN_HIG013_STATUS_DRIFT"));
});

test("status audit rejects unsupported cloud completion", async () => {
  const documents = await readOrchestrationDocuments();
  const activated = {
    ...documents,
    plan: documents.plan.replace(
      "**Status:** **Active cloud preparation — authorized 2026-09-11.",
      "**Status:** **Complete."
    ),
  };
  assert.ok(auditOrchestrationStatus(activated).includes("PLAN_WP013_GATE_DRIFT"));
});

test("cloud preparation does not waive physical push evidence", async () => {
  const documents = await readOrchestrationDocuments();
  const changed = { ...documents, plan: documents.plan.replace(
    "**Status:** **Blocked at HIG-013 after completing the local fake-provider phase.",
    "**Status:** **Complete.",
  ) };
  assert.ok(auditOrchestrationStatus(changed).includes("PLAN_WP012_STATUS_DRIFT"));
});

test("cloud preparation requires the disabled-provider boundary", async () => {
  const documents = await readOrchestrationDocuments();
  const changed = { ...documents, plan: documents.plan.replace(
    "WP013 with Maps and push disabled", "WP013 with live providers",
  ) };
  assert.ok(auditOrchestrationStatus(changed).includes("PLAN_WP013_GATE_DRIFT"));
});
