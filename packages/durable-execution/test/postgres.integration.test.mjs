import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { PgBoss } from "pg-boss";
import { Pool } from "pg";
import { createWp007Api, createWp007PostgresApplication, syntheticIds } from "../../api-contracts/dist/index.js";
import { withTenantTransaction } from "../../postgres-persistence/dist/index.js";
import { withFreshDatabase } from "../../postgres-persistence/scripts/database-fixture.mjs";
import { AggregateGapError, createDeterministicFakeTransport, createFakeEffectProvider, createOrderedConsumer,
  createOutboundEffectService, createOutboxStore, createPgBossTransactionalTransport, createReplayService } from "../dist/index.js";

const connectionString = process.env.WP008_DATABASE_URL;
const tenantId = syntheticIds.organizationA;
const tenantB = "22222222-2222-4222-8222-222222222222";
const riderId = "11111111-1111-4111-8111-111111111112";
const auth = { authorization: "Synthetic principal_dispatcher" };
const etagSecret = "synthetic-etag-secret-wp008-tests-1234";
const retainMs = 2_592_300_000;

async function seed(pool, id = tenantId) {
  await withTenantTransaction(pool, id, "kavaroutes_api", async (client) => {
    await client.query("INSERT INTO platform.organization (tenant_id,id,synthetic_name) VALUES ($1,$1,$2)", [id, `Synthetic ${id.slice(0, 8)}`]);
    await client.query("INSERT INTO intake.rider (tenant_id,id,synthetic_reference) VALUES ($1,$2,$3)", [id, id === tenantId ? riderId : randomUUID(), `synthetic-rider-${id.slice(0, 8)}`]);
  });
}

const createPayload = (tripId) => ({ tripId, riderId, serviceDate: "2026-08-24", serviceTimezone: "America/Los_Angeles",
  localServiceTime: "08:00:00", resolvedServiceAt: "2026-08-24T15:00:00.000Z", resolvedUtcOffsetSeconds: -25200, ambiguityPolicy: "reject" });

async function createTrip(app, tripId, key = `key-${tripId}`) {
  const safeKey = key.length >= 16 ? key : `wp008-${key}-synthetic`;
  const response = await app.inject({ method: "POST", url: `/v1/organizations/${tenantId}/trips`, headers: { ...auth, "idempotency-key": safeKey }, payload: createPayload(tripId) });
  assert.equal(response.statusCode, 201, response.body);
  return response;
}

async function countAtomicRows(pool, tripId, key) {
  return withTenantTransaction(pool, tenantId, "kavaroutes_api", async (client) => {
    const result = await client.query(`SELECT
      (SELECT count(*)::int FROM intake.trip_request WHERE id=$1) AS trips,
      (SELECT count(*)::int FROM audit.event WHERE aggregate_id=$1) AS audits,
      (SELECT count(*)::int FROM platform.idempotency_record WHERE operation_key=$2) AS keys,
      (SELECT count(*)::int FROM outbox.message WHERE aggregate_id=$1) AS messages,
      (SELECT count(*)::int FROM outbox.delivery d JOIN outbox.message m ON m.tenant_id=d.tenant_id AND m.id=d.message_id WHERE m.aggregate_id=$1) AS deliveries`, [tripId, key]);
    return result.rows[0];
  });
}

test("vertical state, audit, idempotency, immutable message, and deliveries commit or roll back together", { skip: !connectionString }, async () => {
  await withFreshDatabase(connectionString, "wp008_atomic", async (pool) => {
    await seed(pool);
    for (const failurePoint of ["before-audit", "before-outbox-message", "before-outbox-deliveries", "after-first-outbox-delivery", "before-commit"]) {
      const tripId = randomUUID();
      const key = `atomic-${failurePoint}`;
      const failing = await createWp007Api({ application: createWp007PostgresApplication(pool, { etagSecret, failurePoint }), etagSecret });
      try {
        const response = await failing.inject({ method: "POST", url: `/v1/organizations/${tenantId}/trips`, headers: { ...auth, "idempotency-key": key }, payload: createPayload(tripId) });
        assert.equal(response.statusCode, 500);
      } finally { await failing.close(); }
      assert.deepEqual(await countAtomicRows(pool, tripId, key), { trips: 0, audits: 0, keys: 0, messages: 0, deliveries: 0 });
    }
    const app = await createWp007Api({ application: createWp007PostgresApplication(pool, { etagSecret }), etagSecret });
    try {
      const tripId = randomUUID();
      const created = await createTrip(app, tripId);
      const replay = await app.inject({ method: "POST", url: `/v1/organizations/${tenantId}/trips`, headers: { ...auth, "idempotency-key": `key-${tripId}` }, payload: createPayload(tripId) });
      assert.equal(replay.statusCode, 201);
      assert.equal(replay.headers["kavaroutes-idempotency-replayed"], "true");
      assert.deepEqual(await countAtomicRows(pool, tripId, `key-${tripId}`), { trips: 1, audits: 1, keys: 1, messages: 1, deliveries: 2 });
      await assert.rejects(() => pool.query("UPDATE outbox.message SET event_type='Changed' WHERE tenant_id=$1", [tenantId]), /OUTBOX_IMMUTABLE_RECORD/);
      assert.equal(await withTenantTransaction(pool, tenantB, "kavaroutes_outbox_publisher", async (client) => (await client.query("SELECT count(*)::int AS count FROM outbox.message")).rows[0].count), 0);
    } finally { await app.close(); }
  });
});

test("claims are bounded and exclusive; leases fence stale publishers; pause and retry policy are enforced", { skip: !connectionString }, async () => {
  await withFreshDatabase(connectionString, "wp008_claims", async (pool) => {
    await seed(pool);
    const app = await createWp007Api({ application: createWp007PostgresApplication(pool, { etagSecret }), etagSecret });
    try {
      for (let index = 0; index < 4; index += 1) await createTrip(app, randomUUID(), `claim-${index}`);
    } finally { await app.close(); }
    const store = createOutboxStore(pool);
    const [left, right] = await Promise.all([
      store.claimEligible({ tenantId, publisherId: "publisher.left", route: "projection", limit: 2, leaseMilliseconds: 30_000 }),
      store.claimEligible({ tenantId, publisherId: "publisher.right", route: "projection", limit: 2, leaseMilliseconds: 30_000 }),
    ]);
    assert.equal(new Set([...left, ...right].map((lease) => lease.deliveryId)).size, 4);
    const first = left[0];
    assert.ok(first);
    await store.publishLeased({ tenantId, publisherId: "publisher.left", deliveryId: first.deliveryId, leaseVersion: first.leaseVersion }, createDeterministicFakeTransport());
    const acknowledgementLease = left[1];
    assert.ok(acknowledgementLease);
    const acknowledgementLost = createDeterministicFakeTransport({ loseAcknowledgementOnce: true });
    await assert.rejects(() => store.publishLeased({ tenantId, publisherId: "publisher.left", deliveryId: acknowledgementLease.deliveryId, leaseVersion: acknowledgementLease.leaseVersion }, acknowledgementLost), /SYNTHETIC_ACK_LOST/);
    const duplicatePublication = await store.publishLeased({ tenantId, publisherId: "publisher.left", deliveryId: acknowledgementLease.deliveryId, leaseVersion: acknowledgementLease.leaseVersion }, acknowledgementLost);
    assert.equal(duplicatePublication.duplicate, true);
    assert.equal(acknowledgementLost.enrolled.size, 1);
    const failingLease = right[0];
    assert.ok(failingLease);
    await assert.rejects(() => store.publishLeased({ tenantId, publisherId: "publisher.right", deliveryId: failingLease.deliveryId, leaseVersion: failingLease.leaseVersion }, createDeterministicFakeTransport({ failBeforeEnrollment: true })), /TRANSIENT_DEPENDENCY/);
    assert.equal(await store.failLeased({ tenantId, publisherId: "publisher.right", deliveryId: failingLease.deliveryId, leaseVersion: failingLease.leaseVersion, failureClass: "PERMANENT_VALIDATION" }), "DEAD_LETTERED");

    const authorization = { authorize: async () => true };
    const replay = createReplayService(pool, authorization);
    await replay.setRouteControl({ tenantId, route: "realtime-signal", paused: true, killSwitch: false, reasonCode: "PLANNED_PAUSE", actorReference: "synthetic.operator" });
    assert.equal((await store.claimEligible({ tenantId, publisherId: "publisher.pause", route: "realtime-signal", limit: 10, leaseMilliseconds: 1_000 })).length, 0);
    await replay.setRouteControl({ tenantId, route: "realtime-signal", paused: false, killSwitch: false, reasonCode: "ROUTE_ACTIVE", actorReference: "synthetic.operator" });
    const expiring = await store.claimEligible({ tenantId, publisherId: "publisher.old", route: "realtime-signal", limit: 1, leaseMilliseconds: 1_000 });
    assert.equal(expiring.length, 1);
    await new Promise((resolve) => setTimeout(resolve, 1_050));
    const reclaimed = await store.claimEligible({ tenantId, publisherId: "publisher.new", route: "realtime-signal", limit: 1, leaseMilliseconds: 30_000 });
    assert.equal(reclaimed[0]?.deliveryId, expiring[0]?.deliveryId);
    await assert.rejects(() => store.publishLeased({ tenantId, publisherId: "publisher.old", deliveryId: expiring[0].deliveryId, leaseVersion: expiring[0].leaseVersion }, createDeterministicFakeTransport()), /STALE_DELIVERY_LEASE/);
    const health = await store.routeHealth(tenantId, "projection");
    assert.ok(health.deadLettered >= 1);
    const poisonMessageId = randomUUID();
    const poisonDeliveryId = randomUUID();
    const poisonEventId = randomUUID();
    await withTenantTransaction(pool, tenantId, "kavaroutes_api", async (client) => {
      await client.query(`INSERT INTO outbox.message
        (tenant_id,id,event_id,aggregate_type,aggregate_id,aggregate_version,event_type,schema_version,occurred_at,command_id,
         idempotency_reference_hash,correlation_id,source,classification_reference,purpose_reference,policy_reference,payload,retain_until)
        VALUES ($1,$2,$3,'TRIP_REQUEST',$4,99,'UnknownEvent','v99',now(),$5,$6,$7,'kavaroutes.api','REGULATED_HEALTH','RIDER_INTAKE','privacy-synthetic-v1','{}',now()+interval '30 days 5 minutes')`,
      [tenantId, poisonMessageId, poisonEventId, randomUUID(), randomUUID(), "e".repeat(64), randomUUID()]);
      await client.query(`INSERT INTO outbox.delivery (tenant_id,id,message_id,route,job_type,retain_until)
        VALUES ($1,$2,$3,'projection','kr.projection.trip.v1',now()+interval '30 days 5 minutes')`, [tenantId, poisonDeliveryId, poisonMessageId]);
    });
    const [poisonLease] = await store.claimEligible({ tenantId, publisherId: "publisher.poison", route: "projection", limit: 1, leaseMilliseconds: 30_000 });
    await assert.rejects(() => store.publishLeased({ tenantId, publisherId: "publisher.poison", deliveryId: poisonLease.deliveryId, leaseVersion: poisonLease.leaseVersion }, createDeterministicFakeTransport()), /UNSUPPORTED_SCHEMA/);
    assert.equal(await store.failLeased({ tenantId, publisherId: "publisher.poison", deliveryId: poisonLease.deliveryId, leaseVersion: poisonLease.leaseVersion, failureClass: "UNSUPPORTED_SCHEMA" }), "BLOCKED");
    assert.equal(await withTenantTransaction(pool, tenantId, "kavaroutes_outbox_publisher", async (client) => (await client.query("SELECT status FROM outbox.delivery WHERE id=$1", [poisonDeliveryId])).rows[0].status), "BLOCKED");
    const unavailablePool = new Pool({ connectionString: "postgresql://synthetic:synthetic@127.0.0.1:1/unavailable", connectionTimeoutMillis: 100, max: 1 });
    try { await assert.rejects(() => createOutboxStore(unavailablePool).routeHealth(tenantId, "projection")); } finally { await unavailablePool.end(); }
    assert.ok((await store.routeHealth(tenantId, "projection")).depth >= 0);
  });
});

test("consumer applies exact next versions atomically and treats repeats, gaps, and lost acknowledgements explicitly", { skip: !connectionString }, async () => {
  await withFreshDatabase(connectionString, "wp008_consumer", async (pool) => {
    await seed(pool);
    const tripId = randomUUID();
    const app = await createWp007Api({ application: createWp007PostgresApplication(pool, { etagSecret }), etagSecret });
    try {
      const created = await createTrip(app, tripId, "consumer-create");
      const cancelled = await app.inject({ method: "POST", url: `/v1/organizations/${tenantId}/trips/${tripId}/commands/cancel`,
        headers: { ...auth, "idempotency-key": "consumer-cancel-0001", "if-match": created.headers.etag }, payload: { reasonCode: "SYNTHETIC_REQUESTER_CANCELLED" } });
      assert.equal(cancelled.statusCode, 200, cancelled.body);
    } finally { await app.close(); }
    const payloads = await withTenantTransaction(pool, tenantId, "kavaroutes_outbox_publisher", async (client) => {
      const rows = await client.query(`SELECT d.id AS delivery_id,m.event_id,m.event_type,m.aggregate_type,m.aggregate_id,m.aggregate_version,
        m.correlation_id,m.classification_reference,m.purpose_reference,m.policy_reference,d.route,d.job_type,m.schema_version
        FROM outbox.delivery d JOIN outbox.message m ON m.tenant_id=d.tenant_id AND m.id=d.message_id
        WHERE m.aggregate_id=$1 AND d.route='projection' ORDER BY m.aggregate_version`, [tripId]);
      return rows.rows.map((row) => ({ tenantId, deliveryId: row.delivery_id, eventId: row.event_id, route: row.route, jobType: row.job_type,
        eventType: row.event_type, schemaVersion: row.schema_version, aggregateType: row.aggregate_type, aggregateId: row.aggregate_id,
        aggregateVersion: Number(row.aggregate_version), correlationId: row.correlation_id, classificationReference: row.classification_reference,
        purposeReference: row.purpose_reference, policyReference: row.policy_reference }));
    });
    assert.equal(payloads.length, 2);
    const consumer = createOrderedConsumer(pool, { consumerName: "projection.trip", purposeReference: "RIDER_INTAKE", authorize: async () => true, handlerVersion: "v1" });
    const deniedConsumer = createOrderedConsumer(pool, { consumerName: "projection.denied", purposeReference: "RIDER_INTAKE", authorize: async () => false, handlerVersion: "v1" });
    await assert.rejects(() => deniedConsumer.consume(payloads[0]), /CONSUMER_AUTHORIZATION_DENIED/);
    await assert.rejects(() => consumer.consume(payloads[1]), (error) => error instanceof AggregateGapError && error.expectedVersion === 1 && error.receivedVersion === 2);
    await assert.rejects(() => consumer.consume(payloads[0], { failBeforeCommit: true }), /SYNTHETIC_HANDLER_BEFORE_COMMIT/);
    await assert.rejects(() => consumer.consume(payloads[0], { failAfterCommit: true }), /SYNTHETIC_HANDLER_ACK_LOST/);
    assert.equal(await consumer.consume(payloads[0]), "DUPLICATE");
    assert.equal(await consumer.consume(payloads[1]), "APPLIED");
    assert.equal(await consumer.consume(payloads[1]), "DUPLICATE");
    await withTenantTransaction(pool, tenantId, "kavaroutes_outbox_consumer", async (client) => {
      const projection = await client.query("SELECT applied_version,safe_state FROM outbox.consumer_projection WHERE aggregate_id=$1", [tripId]);
      assert.deepEqual({ version: Number(projection.rows[0].applied_version), state: projection.rows[0].safe_state }, { version: 2, state: "CANCELLED" });
      assert.equal((await client.query("SELECT count(*)::int AS count FROM outbox.consumer_inbox WHERE aggregate_id=$1", [tripId])).rows[0].count, 2);
    });
  });
});

test("external effects reconcile ambiguous outcomes or enter manual review without blind retries", { skip: !connectionString }, async () => {
  await withFreshDatabase(connectionString, "wp008_effect", async (pool) => {
    await seed(pool);
    const tripId = randomUUID();
    const app = await createWp007Api({ application: createWp007PostgresApplication(pool, { etagSecret }), etagSecret });
    try { await createTrip(app, tripId, "effect-create"); } finally { await app.close(); }
    const reference = await withTenantTransaction(pool, tenantId, "kavaroutes_outbox_consumer", async (client) => {
      const result = await client.query(`SELECT d.id AS delivery_id,m.event_id FROM outbox.delivery d JOIN outbox.message m
        ON m.tenant_id=d.tenant_id AND m.id=d.message_id WHERE m.aggregate_id=$1 LIMIT 1`, [tripId]);
      return result.rows[0];
    });
    const service = createOutboundEffectService(pool);
    const transient = createFakeEffectProvider("TRANSIENT_ONCE");
    const transientRequest = { tenantId, deliveryId: reference.delivery_id, eventId: reference.event_id,
      logicalEffectKey: "effect_transient_0001", operation: "SEND_SYNTHETIC", requestFingerprint: "a".repeat(64) };
    await assert.rejects(() => service.execute(transientRequest, transient), /TRANSIENT_DEPENDENCY/);
    assert.equal(await service.execute(transientRequest, transient), "SUCCEEDED");
    assert.equal(new Set(transient.calls).size, 1);
    const permanent = createFakeEffectProvider("PERMANENT");
    assert.equal(await service.execute({ tenantId, deliveryId: reference.delivery_id, eventId: reference.event_id,
      logicalEffectKey: "effect_permanent_0001", operation: "SEND_SYNTHETIC", requestFingerprint: "d".repeat(64) }, permanent), "PERMANENT_FAILURE");
    const reconcilable = createFakeEffectProvider("AMBIGUOUS_RECONCILABLE");
    assert.equal(await service.execute({ tenantId, deliveryId: reference.delivery_id, eventId: reference.event_id,
      logicalEffectKey: "effect_reconcilable_001", operation: "SEND_SYNTHETIC", requestFingerprint: "b".repeat(64) }, reconcilable), "RECONCILED");
    assert.equal(reconcilable.calls.length, 1);
    const unsupported = createFakeEffectProvider("AMBIGUOUS_UNSUPPORTED");
    const request = { tenantId, deliveryId: reference.delivery_id, eventId: reference.event_id,
      logicalEffectKey: "effect_unsupported_001", operation: "SEND_SYNTHETIC", requestFingerprint: "c".repeat(64) };
    assert.equal(await service.execute(request, unsupported), "MANUAL_REVIEW");
    assert.equal(await service.execute(request, unsupported), "MANUAL_REVIEW");
    assert.equal(unsupported.calls.length, 1);
  });
});

test("replay is authorized, dry-run planned, bounded, audited, pausable, and kill-switch aware", { skip: !connectionString }, async () => {
  await withFreshDatabase(connectionString, "wp008_replay", async (pool) => {
    await seed(pool);
    const app = await createWp007Api({ application: createWp007PostgresApplication(pool, { etagSecret }), etagSecret });
    try { await createTrip(app, randomUUID(), "replay-create-0001"); await createTrip(app, randomUUID(), "replay-create-0002"); } finally { await app.close(); }
    const store = createOutboxStore(pool);
    const leases = await store.claimEligible({ tenantId, publisherId: "publisher.replay", route: "projection", limit: 2, leaseMilliseconds: 30_000 });
    for (const lease of leases) await store.failLeased({ tenantId, publisherId: "publisher.replay", deliveryId: lease.deliveryId, leaseVersion: lease.leaseVersion, failureClass: "PERMANENT_VALIDATION" });
    const denied = createReplayService(pool, { authorize: async () => false });
    await assert.rejects(() => denied.plan({ tenantId, route: "projection", limit: 10, sideEffectClass: "INTERNAL", reasonCode: "INCIDENT_RECOVERY", actorReference: "synthetic.denied" }), /REPLAY_AUTHORIZATION_DENIED/);
    const replay = createReplayService(pool, { authorize: async () => true });
    const planned = await replay.plan({ tenantId, route: "projection", limit: 10, sideEffectClass: "INTERNAL", reasonCode: "INCIDENT_RECOVERY", actorReference: "synthetic.operator" });
    assert.equal(planned.candidateCount, 2);
    assert.equal(planned.schemaCompatibility, "COMPATIBLE_REGISTERED_VERSIONS_ONLY");
    await replay.setRouteControl({ tenantId, route: "projection", paused: false, killSwitch: true, reasonCode: "EMERGENCY_STOP", actorReference: "synthetic.operator" });
    await assert.rejects(() => replay.execute({ tenantId, replayId: planned.replayId, actorReference: "synthetic.operator", batchSize: 1 }), /REPLAY_ROUTE_STOPPED/);
    await replay.setRouteControl({ tenantId, route: "projection", paused: false, killSwitch: false, reasonCode: "ROUTE_ACTIVE", actorReference: "synthetic.operator" });
    assert.deepEqual(await replay.execute({ tenantId, replayId: planned.replayId, actorReference: "synthetic.operator", batchSize: 1 }), { redriven: 1, completed: false });
    await replay.setRouteControl({ tenantId, route: "projection", paused: true, killSwitch: false, reasonCode: "INTERRUPTED_REPLAY", actorReference: "synthetic.operator" });
    await assert.rejects(() => replay.execute({ tenantId, replayId: planned.replayId, actorReference: "synthetic.operator", batchSize: 1 }), /REPLAY_ROUTE_STOPPED/);
    await replay.setRouteControl({ tenantId, route: "projection", paused: false, killSwitch: false, reasonCode: "ROUTE_ACTIVE", actorReference: "synthetic.operator" });
    assert.deepEqual(await replay.execute({ tenantId, replayId: planned.replayId, actorReference: "synthetic.operator", batchSize: 1 }), { redriven: 1, completed: false });
    assert.deepEqual(await replay.execute({ tenantId, replayId: planned.replayId, actorReference: "synthetic.operator", batchSize: 1 }), { redriven: 0, completed: true });
    await withTenantTransaction(pool, tenantId, "kavaroutes_outbox_consumer", async (client) => {
      const linked = await client.query("SELECT count(*)::int AS count FROM outbox.delivery_attempt WHERE attempt_kind='REDRIVE' AND original_attempt_id IS NOT NULL");
      assert.equal(linked.rows[0].count, 2);
    });
  });
});

test("pg-boss public transaction adapter rolls enqueue back with outbox mark and commits both together", { skip: !connectionString }, async () => {
  await withFreshDatabase(connectionString, "wp008_pgboss", async (pool, databaseUrl) => {
    await seed(pool);
    const app = await createWp007Api({ application: createWp007PostgresApplication(pool, { etagSecret }), etagSecret });
    try { await createTrip(app, randomUUID(), "pgboss-create"); } finally { await app.close(); }
    const boss = new PgBoss({ connectionString: databaseUrl, schema: "wp008_boss", schedule: false, supervise: false });
    await boss.start();
    try {
      await boss.createQueue("kr.projection.v1");
      await pool.query("GRANT USAGE ON SCHEMA wp008_boss TO kavaroutes_outbox_publisher");
      await pool.query("GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA wp008_boss TO kavaroutes_outbox_publisher");
      await pool.query("GRANT USAGE,SELECT,UPDATE ON ALL SEQUENCES IN SCHEMA wp008_boss TO kavaroutes_outbox_publisher");
      const store = createOutboxStore(pool);
      const [lease] = await store.claimEligible({ tenantId, publisherId: "publisher.pgboss", route: "projection", limit: 1, leaseMilliseconds: 30_000 });
      const transport = createPgBossTransactionalTransport(boss);
      await assert.rejects(() => store.publishLeased({ tenantId, publisherId: "publisher.pgboss", deliveryId: lease.deliveryId, leaseVersion: lease.leaseVersion },
        { supportsAtomicEnrollment: true, send: async (client, payload) => { await transport.send(client, payload); throw new Error("SYNTHETIC_AFTER_ENQUEUE"); } }), /SYNTHETIC_AFTER_ENQUEUE/);
      assert.equal((await pool.query("SELECT count(*)::int AS count FROM wp008_boss.job")).rows[0].count, 0);
      await store.publishLeased({ tenantId, publisherId: "publisher.pgboss", deliveryId: lease.deliveryId, leaseVersion: lease.leaseVersion }, transport);
      assert.equal((await pool.query("SELECT count(*)::int AS count FROM wp008_boss.job")).rows[0].count, 1);
      assert.equal(await withTenantTransaction(pool, tenantId, "kavaroutes_outbox_publisher", async (client) => (await client.query("SELECT status FROM outbox.delivery WHERE id=$1", [lease.deliveryId])).rows[0].status), "PUBLISHED");
    } finally { await boss.stop({ graceful: false, wait: false }); }
  });
});
