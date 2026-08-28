import assert from "node:assert/strict";
import test from "node:test";
import { createSubmitSyntheticProbe } from "@kavaroutes/platform-engine/application";
import { createMemoryAdapters, validateSyntheticJobPayload } from "@kavaroutes/platform-engine/adapters";
import { acceptSyntheticProbe, resolveEffectiveDriverPolicy } from "@kavaroutes/platform-engine/domain";
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

test("Driver policy resolver separates tier, workforce, floors, locks, and capability", () => {
  const base = { organizationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", driverId: "30000000-0000-4000-8000-000000000001",
    assignmentId: "40000000-0000-4000-8000-000000000001", policyVersion: 1, resolvedAt: "2026-08-27T12:00:00.000Z" };
  let cases = 0;
  for (const commercialTier of ["SMALL_BUSINESS", "ENTERPRISE"]) for (const workforceRelationship of ["OWNER_OPERATOR", "EMPLOYEE", "CONTRACTOR"])
    for (const externalFloor of [undefined, { preInspection: { mode: "REQUIRED", locked: true } }]) for (const locked of [false, true]) {
      const result = resolveEffectiveDriverPolicy({ ...base, commercialTier, workforceRelationship, externalFloor,
        organization: { preInspection: { mode: locked ? "REQUIRED" : "DISABLED", locked } }, capabilities: new Set() });
      assert.match(result.canonicalDigest, /^[a-f0-9]{64}$/); assert.equal(result.schemaVersion, 1); cases++;
      if (externalFloor) { assert.equal(result.preInspection.mode, "REQUIRED"); assert.equal(result.preInspection.source, "EXTERNAL_FLOOR"); }
      else if (locked) { assert.equal(result.preInspection.mode, "REQUIRED"); assert.equal(result.preInspection.source, "ORGANIZATION_LOCK"); }
      else { assert.equal(result.preInspection.mode, "DISABLED"); assert.equal(result.preInspection.source, "ORGANIZATION_CONFIGURATION"); }
    }
  assert.equal(cases, 24);
  const owner = resolveEffectiveDriverPolicy({ ...base, commercialTier: "SMALL_BUSINESS", workforceRelationship: "OWNER_OPERATOR", capabilities: new Set(["driver-route:self-approve"]) });
  assert.equal(owner.preInspection.mode, "OPTIONAL"); assert.equal(owner.returnVerification.mode, "ADVISORY"); assert.equal(owner.routeChange.mode, "AUTHORIZED_SELF_APPROVE");
  const noCapability = resolveEffectiveDriverPolicy({ ...base, commercialTier: "SMALL_BUSINESS", workforceRelationship: "OWNER_OPERATOR", capabilities: new Set() });
  assert.equal(noCapability.routeChange.mode, "DISPATCH_APPROVAL_REQUIRED"); assert.equal(noCapability.routeChange.reasonCode, "SELF_APPROVAL_CAPABILITY_MISSING");
  const strictSmall = resolveEffectiveDriverPolicy({ ...base, commercialTier: "SMALL_BUSINESS", workforceRelationship: "OWNER_OPERATOR", organization: { preInspection: { mode: "REQUIRED", locked: true } }, capabilities: new Set() });
  assert.equal(strictSmall.preInspection.mode, "REQUIRED");
  const modularEnterprise = resolveEffectiveDriverPolicy({ ...base, commercialTier: "ENTERPRISE", workforceRelationship: "EMPLOYEE", organization: { preInspection: { mode: "OPTIONAL", locked: false } }, capabilities: new Set() });
  assert.equal(modularEnterprise.preInspection.mode, "OPTIONAL");
});
