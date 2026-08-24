import assert from "node:assert/strict";
import test from "node:test";
import { createSubmitSyntheticProbe } from "@kavaroutes/platform-engine/application";
import { createMemoryAdapters, validateSyntheticJobPayload } from "@kavaroutes/platform-engine/adapters";
import { acceptSyntheticProbe } from "@kavaroutes/platform-engine/domain";
import { createRequestContext } from "@kavaroutes/shared-kernel";
import { syntheticContext } from "@kavaroutes/platform-test-support";

test("request context is immutable and rejects unsafe placeholders", () => {
  const context = syntheticContext();
  assert.ok(Object.isFrozen(context));
  assert.throws(() => createRequestContext({
    operationId: "bad value",
    tenantPlaceholder: "tenant_ok",
    actorPlaceholder: "actor_ok",
    purposePlaceholder: "purpose_ok",
    correlationId: "corr_ok"
  }), /UNSAFE_CONTEXT_IDENTIFIER/);
});

test("domain probe accepts only conspicuously synthetic IDs", () => {
  assert.equal(acceptSyntheticProbe("probe_1234abcd", "alpha").outcome, "accepted");
  assert.throws(() => acceptSyntheticProbe("real-trip-1", "alpha"), /INVALID_SYNTHETIC_PROBE_ID/);
});

test("application handler composes declared ports", async () => {
  const submit = createSubmitSyntheticProbe(createMemoryAdapters());
  const result = await submit(syntheticContext(), {
    probeId: "probe_1234abcd",
    input: "bravo",
    idempotencyKey: "idem_synthetic_01"
  });
  assert.equal(result.probe.input, "bravo");
  assert.equal(result.jobId, "job_idem_synthetic_01");
});

test("minimum-data worker payload fails closed", () => {
  assert.deepEqual(validateSyntheticJobPayload({ probeId: "probe_1234abcd", operationId: "op_safe_001" }), {
    probeId: "probe_1234abcd",
    operationId: "op_safe_001"
  });
  assert.throws(() => validateSyntheticJobPayload({
    probeId: "probe_1234abcd",
    operationId: "op_safe_001",
    address: "CANARY_ADDRESS_PRIVATE_95"
  }), /INVALID_JOB_PAYLOAD/);
});

test("package exports reject unapproved deep imports", async () => {
  await assert.rejects(
    import("@kavaroutes/platform-engine/dist/domain/index.js"),
    (error) => error?.code === "ERR_PACKAGE_PATH_NOT_EXPORTED"
  );
});
