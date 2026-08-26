import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { createWp007Api, createWp007PostgresApplication, createSyntheticTestVerifier, syntheticIds } from "@kavaroutes/api-contracts";
import { withTenantTransaction } from "@kavaroutes/postgres-persistence";
import { withFreshDatabase } from "../../postgres-persistence/scripts/database-fixture.mjs";
import { authorizeRealtimeSubscription, createTestOnlyCursorCodec, locationShard } from "../dist/index.js";
import { createPostgresRealtimeStore, createPostgresWakeSource } from "../dist/postgres.js";

const connectionString = process.env.WP009_DATABASE_URL ?? process.env.WP008_DATABASE_URL;
const tenantId = syntheticIds.organizationA;
const riderId = "11111111-1111-4111-8111-111111111112";
const scope = Object.freeze({ streamKind: "DISPATCH_DAY", scopeReference: "branch:synthetic-all", serviceDate: "2026-08-25" });
const locationBaseScope = Object.freeze({ streamKind: "CURRENT_POSITION", scopeReference: "fleet:synthetic-all" });

async function seed(pool) {
  await withTenantTransaction(pool, tenantId, "kavaroutes_api", async (client) => {
    await client.query("INSERT INTO platform.organization (tenant_id,id,synthetic_name) VALUES ($1,$1,'Synthetic WP009')", [tenantId]);
    await client.query("INSERT INTO intake.rider (tenant_id,id,synthetic_reference) VALUES ($1,$2,'synthetic-rider-wp009')", [tenantId, riderId]);
  });
}

const tripPayload = (tripId) => ({ tripId, riderId, serviceDate: "2026-08-25", serviceTimezone: "America/Los_Angeles",
  localServiceTime: "08:00:00", resolvedServiceAt: "2026-08-25T15:00:00.000Z", resolvedUtcOffsetSeconds: -25200, ambiguityPolicy: "reject" });

function thin(row) {
  return { tenantId, deliveryId: row.delivery_id, eventId: row.event_id, route: row.route, jobType: row.job_type,
    eventType: row.event_type, schemaVersion: row.schema_version, aggregateType: row.aggregate_type, aggregateId: row.aggregate_id,
    aggregateVersion: Number(row.aggregate_version), correlationId: row.correlation_id, classificationReference: row.classification_reference,
    purposeReference: row.purpose_reference, policyReference: row.policy_reference };
}

async function loadSignals(pool, aggregateId) {
  return withTenantTransaction(pool, tenantId, "kavaroutes_outbox_consumer", async (client) => {
    const result = await client.query(`SELECT d.id AS delivery_id,m.event_id,m.event_type,m.aggregate_type,m.aggregate_id,m.aggregate_version,
      m.correlation_id,m.classification_reference,m.purpose_reference,m.policy_reference,d.route,d.job_type,m.schema_version
      FROM outbox.delivery d JOIN outbox.message m ON m.tenant_id=d.tenant_id AND m.id=d.message_id
      WHERE m.aggregate_id=$1 AND d.route='realtime-signal' ORDER BY m.aggregate_version`, [aggregateId]);
    return result.rows.map(thin);
  });
}

async function insertSignal(pool, aggregateId, version) {
  const messageId = randomUUID(); const eventId = randomUUID(); const deliveryId = randomUUID();
  await withTenantTransaction(pool, tenantId, "kavaroutes_api", async (client) => {
    await client.query(`INSERT INTO outbox.message
      (tenant_id,id,event_id,aggregate_type,aggregate_id,aggregate_version,event_type,schema_version,occurred_at,command_id,
       idempotency_reference_hash,correlation_id,source,classification_reference,purpose_reference,policy_reference,payload,retain_until)
      VALUES ($1,$2,$3,'LOCATION_STREAM',$4,$5,'LocationBatchRecorded','v1',now(),$6,$7,$8,'kavaroutes.api','SENSITIVE_LOCATION','ASSIGNED_SERVICE_DELIVERY','privacy-synthetic-v1',$9,now()+interval '30 days 5 minutes')`,
    [tenantId, messageId, eventId, aggregateId, version, randomUUID(), "a".repeat(64), randomUUID(), { batchReference: `ref_synthetic_location_${version}`, sampleCount: 1 }]);
    await client.query(`INSERT INTO outbox.delivery (tenant_id,id,message_id,route,job_type,retain_until)
      VALUES ($1,$2,$3,'realtime-signal','kr.realtime-signal.location.v1',now()+interval '30 days 5 minutes')`, [tenantId, deliveryId, messageId]);
  });
  return loadSignals(pool, aggregateId).then((items) => items.find((item) => item.eventId === eventId));
}

test("migration, RLS, atomic consumer, stream ordering, snapshot race, replay, notify, coalescing, and reset pass", { skip: !connectionString }, async () => {
  await withFreshDatabase(connectionString, "wp009_realtime", async (pool) => {
    await seed(pool);
    const tripId = randomUUID();
    const app = await createWp007Api({ application: createWp007PostgresApplication(pool, { etagSecret: "synthetic-etag-secret-wp009-tests-1234" }), etagSecret: "synthetic-etag-secret-wp009-tests-1234" });
    try {
      const created = await app.inject({ method: "POST", url: `/v1/organizations/${tenantId}/trips`, headers: { authorization: "Synthetic principal_dispatcher", "idempotency-key": "wp009-create-trip-0001" }, payload: tripPayload(tripId) });
      assert.equal(created.statusCode, 201, created.body);
      const cancelled = await app.inject({ method: "POST", url: `/v1/organizations/${tenantId}/trips/${tripId}/commands/cancel`, headers: { authorization: "Synthetic principal_dispatcher", "idempotency-key": "wp009-cancel-trip-0001", "if-match": created.headers.etag }, payload: { reasonCode: "SYNTHETIC_REQUESTER_CANCELLED" } });
      assert.equal(cancelled.statusCode, 200, cancelled.body);
    } finally { await app.close(); }
    const signals = await loadSignals(pool, tripId);
    assert.equal(signals.length, 2);

    const codec = createTestOnlyCursorCodec({ now: () => new Date("2026-08-25T12:00:00.000Z") });
    const store = createPostgresRealtimeStore(pool, codec);
    const decision = (lifecycle, version) => ({ purpose: "DISPATCH_CONTROL", scope,
      delta: { kind: "DISPATCH_CONTROL", tripReference: "trip:synthetic:database", lifecycle, resourceVersion: version }, committedAt: new Date(`2026-08-25T12:00:0${version}.000Z`) });
    await assert.rejects(() => store.consume(signals[1], decision("CANCELLED", 2)), /VERSION_GAP:1:2/);
    await assert.rejects(() => store.consume(signals[0], decision("DISPATCHED", 1), { failBeforeCommit: true }), /BEFORE_COMMIT/);
    assert.equal((await pool.query("SELECT count(*)::int AS count FROM realtime.change")).rows[0].count, 0);

    const wakeSource = createPostgresWakeSource(pool);
    let wakeResolve;
    const woke = new Promise((resolve) => { wakeResolve = resolve; });
    await wakeSource.start((payload) => { assert.equal(payload, ""); wakeResolve(); });
    try {
    await assert.rejects(() => store.consume(signals[0], decision("DISPATCHED", 1), { failAfterCommit: true }), /AFTER_COMMIT/);
    try {
      await Promise.race([woke, new Promise((_, reject) => setTimeout(() => reject(new Error("REALTIME_NOTIFICATION_TIMEOUT")), 2_000))]);
    } catch (error) { throw error; }
    assert.equal(await store.consume(signals[0], decision("DISPATCHED", 1)), "DUPLICATE");

    const principal = await createSyntheticTestVerifier().verify("Synthetic principal_dispatcher");
    assert.ok(principal);
    const auth = authorizeRealtimeSubscription({ principal, organizationId: tenantId, authorizationGeneration: 1, purpose: "DISPATCH_CONTROL", scope });
    const snapshot = await store.snapshot(auth);
    assert.equal(Object.keys(snapshot.projection).length, 1);
    assert.equal(await store.consume(signals[1], decision("CANCELLED", 2)), "APPLIED");
    const replay = await store.replay(auth, snapshot.cursor);
    assert.equal(replay.outcome, "REPLAY");
    assert.equal(replay.changes.length, 1);
    assert.equal(replay.changes[0].delta.resourceVersion, 2);
    assert.equal((await store.replay(auth, replay.cursor)).changes.length, 0);

    const locationAggregate = randomUUID();
    const first = await insertSignal(pool, locationAggregate, 1);
    const second = await insertSignal(pool, locationAggregate, 2);
    assert.ok(first && second);
    const shard = locationShard("driver:synthetic:database", 8);
    const position = (version, milliseconds) => ({ purpose: "DISPATCH_CURRENT_POSITION", scope: { ...locationBaseScope, shard },
      committedAt: new Date(1_777_118_400_000 + milliseconds), delta: { kind: "CURRENT_POSITION", driverReference: "driver:synthetic:database",
        latitude: 34.1, longitude: -118.2, accuracyMeters: 5, capturedAt: new Date(1_777_118_400_000 + milliseconds).toISOString(), resourceVersion: version } });
    assert.equal(await store.consume(first, position(1, 0)), "APPLIED");
    assert.equal(await store.consume(second, position(2, 100)), "COALESCED");
    const locationChanges = await pool.query("SELECT count(*)::int AS count,max(resource_version)::int AS version FROM realtime.change WHERE delta_kind='CURRENT_POSITION'");
    assert.deepEqual(locationChanges.rows[0], { count: 1, version: 2 });
    assert.equal((await pool.query("SELECT count(*)::int AS count FROM realtime.consumer_checkpoint WHERE source_aggregate_id=$1", [locationAggregate])).rows[0].count, 2);

    const stream = await pool.query("SELECT id,last_sequence FROM realtime.stream WHERE purpose='DISPATCH_CONTROL'");
    await pool.query("UPDATE realtime.stream SET minimum_sequence=last_sequence+1,lifecycle='RESET_REQUIRED' WHERE id=$1", [stream.rows[0].id]);
    assert.equal((await store.replay(auth, snapshot.cursor)).outcome, "RESET_REQUIRED");
    assert.equal(await wakeSource.queueUsage() >= 0, true);

    const tenantBVisibility = await withTenantTransaction(pool, syntheticIds.organizationB, "kavaroutes_realtime", async (client) => (await client.query("SELECT count(*)::int AS count FROM realtime.change")).rows[0].count);
    assert.equal(tenantBVisibility, 0);
    const schema = await pool.query("SELECT count(*)::int AS tables FROM information_schema.tables WHERE table_schema='realtime' AND table_name IN ('stream','projection','change','consumer_checkpoint')");
    assert.equal(schema.rows[0].tables, 4);
    const counts = await pool.query(`SELECT
      (SELECT count(*)::int FROM realtime.stream) AS streams,
      (SELECT count(*)::int FROM realtime.projection) AS projections,
      (SELECT count(*)::int FROM realtime.change) AS changes,
      (SELECT count(*)::int FROM realtime.consumer_checkpoint) AS checkpoints`);
    const statementStats = await pool.query("SELECT COALESCE(sum(calls),0)::bigint AS calls FROM pg_stat_statements WHERE query LIKE '%realtime.%'");
    process.stdout.write(`WP009 database evidence ${JSON.stringify({ ...counts.rows[0], statementCalls: Number(statementStats.rows[0].calls), notificationQueueUsage: await wakeSource.queueUsage(), poolConnections: pool.totalCount, poolIdle: pool.idleCount, notificationPayloadBytes: 0 })}\n`);
    } finally { await wakeSource.stop(); }
  });
});
