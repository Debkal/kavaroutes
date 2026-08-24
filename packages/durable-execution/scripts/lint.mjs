import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { FAILURE_POLICIES, OUTBOX_ROUTES, ROUTE_POLICIES } from "../dist/index.js";

assert.equal(OUTBOX_ROUTES.length, 8);
assert.deepEqual(Object.keys(ROUTE_POLICIES).sort(), [...OUTBOX_ROUTES].sort());
for (const policy of Object.values(ROUTE_POLICIES)) {
  assert.ok(policy.concurrency >= 1 && policy.concurrency <= 32);
  assert.ok(policy.leaseSeconds > policy.executionTimeoutSeconds);
  assert.ok(policy.heartbeatSeconds > 0 && policy.heartbeatSeconds < policy.leaseSeconds);
  assert.ok(policy.maximumAgeSeconds >= policy.executionTimeoutSeconds);
  assert.match(policy.queue, /^kr\.[a-z][a-z0-9.-]{2,63}\.v[1-9][0-9]*$/);
  assert.match(policy.deadLetterRoute, /^kr\.[a-z][a-z0-9.-]{2,63}\.v[1-9][0-9]*$/);
}
for (const policy of Object.values(FAILURE_POLICIES)) {
  assert.ok(policy.maximumAttempts >= 1 && policy.maximumAttempts <= 10);
  assert.ok(policy.maximumDelaySeconds <= 900);
  assert.ok(policy.maximumAgeSeconds <= 259_200);
  assert.ok(policy.circuitOpenAfter >= 1 && policy.concurrencyLimit >= 1);
  assert.match(policy.deadLetterReason, /^[A-Z][A-Z0-9_]{2,63}$/);
  if (!policy.retryable) assert.equal(policy.maximumAttempts, 1);
}
for (const name of ["route-policy-catalog.json", "failure-policy-catalog.json"]) {
  const text = await readFile(resolve(import.meta.dirname, "../artifacts", name), "utf8");
  assert.doesNotMatch(text, /tenantId|eventId|deliveryId|payload|address|phone|email|latitude|longitude/i);
}
process.stdout.write("WP008 policy lint passed\n");
