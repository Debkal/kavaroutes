import assert from "node:assert/strict";
import test from "node:test";
import {
  assertNoProhibitedPushData, createAdmissionController, createDeliveryCoordinator, createDirectApnsPort,
  createDirectFcmPort, createFakePushPort, createNotificationIntent, createNotificationRecovery,
  createPushEnvelope, createRegistrationService, createTokenVault, deriveDeliveryInstruction,
  parseNativeNotification, permissionState, validatePushEnvelope,
} from "../dist/index.js";

const ids = Object.freeze({
  organization: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", otherOrganization: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  principal: "10000000-0000-4000-8000-000000000002", subject: "30000000-0000-4000-8000-000000000001",
  installation: "50000000-0000-4000-8000-000000000001", secondInstallation: "50000000-0000-4000-8000-000000000002",
});
const token = "synthetic_native_token_0000000000000001";
const context = { organizationId: ids.organization, principalId: ids.principal, subjectId: ids.subject, idempotencyKey: "idem_push_000000000001" };
const input = { organizationId: ids.organization, principalId: ids.principal, subjectId: ids.subject, installationId: ids.installation,
  generation: "gen_synthetic000001", platform: "android", provider: "fcm", environment: "development",
  appId: "com.kavaroutes.driver.synthetic", token, permission: "granted", channelEnabled: true, policyVersion: "push.policy.v1" };

test("closed envelope accepts only three kinds and rejects extra or prohibited data", () => {
  for (const kind of ["sync_available", "review_update", "session_attention"]) assert.deepEqual(createPushEnvelope(kind), { v: "1", kind, action: "open_and_sync" });
  assert.throws(() => validatePushEnvelope({ v: "1", kind: "sync_available", action: "open_and_sync", tripId: ids.installation }), /PUSH_ENVELOPE_INVALID/);
  assert.throws(() => assertNoProhibitedPushData({ safe: { patient_name: "Synthetic Rider" } }), /PUSH_DATA_POLICY_VIOLATION/);
  assert.throws(() => assertNoProhibitedPushData({ safe: `https://example.test/${ids.installation}` }), /PUSH_DATA_POLICY_VIOLATION/);
});

test("registration tokens are encrypted, equality-hashed, tenant-bound, rotatable, and revocable", () => {
  const vault = createTokenVault({ encryptionKey: Buffer.alloc(32, 7), equalityKey: Buffer.alloc(32, 9), ivFactory: () => Buffer.alloc(12, 4) });
  assert.notEqual(vault.seal(token), token); assert.equal(vault.open(vault.seal(token)), token); assert.equal(vault.hash(token).length, 64);
  const service = createRegistrationService({ vault, now: () => new Date("2026-08-29T00:00:00.000Z") });
  const registered = service.register(context, input); assert.equal(registered.lifecycle, "active"); assert.equal("token" in registered, false);
  assert.deepEqual(service.register(context, input), registered);
  assert.throws(() => service.register({ ...context, organizationId: ids.otherOrganization, idempotencyKey: "idem_push_000000000002" }, input), /CONTEXT_MISMATCH/);
  service.register({ ...context, idempotencyKey: "idem_push_000000000003" }, { ...input, generation: "gen_synthetic000002", token: `${token}rotated` });
  assert.throws(() => service.tokenFor(ids.organization, ids.installation, input.generation), /NOT_ACTIVE/);
  const revoked = service.unregister({ organizationId: ids.organization, principalId: ids.principal, subjectId: ids.subject },
    { installationId: ids.installation, generation: "gen_synthetic000002", reason: "logout" });
  assert.equal(revoked.lifecycle, "inactive"); assert.equal(revoked.inactiveReason, "logout");
});

test("platform policy derives safe collapse, expiry, visibility, and iOS rate limits", () => {
  const createdAt = "2026-08-29T00:00:00.000Z";
  const ios = deriveDeliveryInstruction({ kind: "sync_available", platform: "ios", createdAt });
  assert.deepEqual({ visible: ios.visible, priority: ios.priority, collapse: ios.collapseClass, expiresAt: ios.expiresAt },
    { visible: false, priority: "low", collapse: "sync", expiresAt: "2026-08-29T00:05:00.000Z" });
  const visible = deriveDeliveryInstruction({ kind: "review_update", platform: "android", createdAt });
  assert.equal(visible.body, "KavaRoutes has an update. Open the app to review."); assert.equal(visible.priority, "high");
  const admission = createAdmissionController({ now: () => new Date("2026-08-29T00:01:00.000Z") });
  assert.equal(admission.admit({ installationKey: "install-a", intentId: "intent_000000000001", instruction: ios }), "admitted");
  assert.equal(admission.admit({ installationKey: "install-a", intentId: "intent_000000000002", instruction: ios }), "admitted");
  assert.equal(admission.admit({ installationKey: "install-a", intentId: "intent_000000000003", instruction: ios }), "rate_limited");
});

test("effects are persisted logically before fake calls and normalize retry, ambiguity, and invalidation", async () => {
  const now = () => new Date("2026-08-29T00:01:00.000Z"); const coordinator = createDeliveryCoordinator({ now });
  const intent = createNotificationIntent({ intentId: "intent_000000000010", kind: "review_update", createdAt: "2026-08-29T00:00:00.000Z" });
  const target = { installationKey: "install-a", platform: "android", provider: "fcm", environment: "development", appId: "com.kavaroutes.driver.synthetic", token };
  const transient = createFakePushPort(["transient_provider", "accepted"]);
  const first = await coordinator.deliver(intent, target, transient); assert.equal(first.state, "retry_scheduled"); assert.equal(first.attempts, 1);
  const second = await coordinator.deliver(intent, target, transient); assert.equal(second.state, "provider_accepted"); assert.equal(second.attempts, 2);
  const replay = await coordinator.deliver(intent, target, transient); assert.equal(replay.attempts, 2); assert.equal(transient.calls.length, 2);
  const invalid = await createDeliveryCoordinator({ now }).deliver(createNotificationIntent({ intentId: "intent_000000000011", kind: "review_update", createdAt: "2026-08-29T00:00:00.000Z" }), target, createFakePushPort(["invalid_registration"]));
  assert.equal(invalid.state, "permanent");
  const ambiguous = await createDeliveryCoordinator({ now }).deliver(createNotificationIntent({ intentId: "intent_000000000012", kind: "review_update", createdAt: "2026-08-29T00:00:00.000Z" }), target, createFakePushPort(["ambiguous_timeout"]));
  assert.equal(ambiguous.state, "ambiguous");
});

test("direct adapters fail closed while unconfigured and derive provider requests only inside injected transports", async () => {
  const instruction = deriveDeliveryInstruction({ kind: "sync_available", platform: "ios", createdAt: "2026-08-29T00:00:00.000Z" });
  let calls = 0; const transport = { async exchange(request) { calls += 1; assert.match(request.endpoint, /^https:\/\//); return { status: 200 }; } };
  const apns = createDirectApnsPort({ configured: false, topic: "com.kavaroutes.driver.synthetic", authorization: async () => "synthetic-unreachable", transport });
  await assert.rejects(apns.send({ platform: "ios", provider: "apns", environment: "sandbox", appId: "com.kavaroutes.driver.synthetic", token }, instruction), /HIG_013_REQUIRED/);
  const fcm = createDirectFcmPort({ configured: false, projectReference: "synthetic-unreachable", oauth: { scope: "https://www.googleapis.com/auth/firebase.messaging", token: async () => "synthetic-unreachable" }, transport });
  await assert.rejects(fcm.send({ platform: "android", provider: "fcm", environment: "development", appId: "com.kavaroutes.driver.synthetic", token },
    deriveDeliveryInstruction({ kind: "sync_available", platform: "android", createdAt: "2026-08-29T00:00:00.000Z" })), /HIG_013_REQUIRED/);
  assert.equal(calls, 0);
});

test("permission denial and every wake path preserve authoritative authenticate-and-sync recovery", async () => {
  assert.equal(permissionState({ requested: false, granted: false, systemEnabled: true }), "not_requested");
  assert.equal(permissionState({ requested: true, granted: false, systemEnabled: true }), "denied");
  assert.equal(permissionState({ requested: true, granted: true, systemEnabled: true, channelEnabled: false }), "channel_limited");
  assert.equal(parseNativeNotification({ v: "1", kind: "sync_available", action: "open_and_sync" })?.kind, "sync_available");
  assert.equal(parseNativeNotification({ v: "1", kind: "sync_available", action: "accept_trip" }), null);
  const calls = []; const recovery = createNotificationRecovery({
    async openSafeUpdatesEntry() { calls.push("open"); }, async authenticate() { calls.push("auth"); return "authenticated"; },
    async synchronize(reason) { calls.push(`sync:${reason}`); return { projectionDigest: "a".repeat(64) }; },
  });
  assert.equal((await recovery.recover("notification", { v: "1", kind: "sync_available", action: "open_and_sync" })).outcome, "synchronized");
  assert.deepEqual(calls, ["open", "auth", "sync:notification"]);
  calls.length = 0; await recovery.recover("foreground"); assert.deepEqual(calls, ["auth", "sync:foreground"]);
});
