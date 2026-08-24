import assert from "node:assert/strict";
import test from "node:test";
import { createWp007Api, createWp007PostgresApplication, requestFingerprint, syntheticIds } from "../dist/index.js";
import { withTenantTransaction } from "../../postgres-persistence/dist/index.js";
import { withFreshDatabase } from "../../postgres-persistence/scripts/database-fixture.mjs";

const connectionString = process.env.WP007_DATABASE_URL;
const organizationId = syntheticIds.organizationA;
const riderId = "11111111-1111-4111-8111-111111111112";
const auth = { authorization: "Synthetic principal_dispatcher" };
const createPayload = (tripId) => ({ tripId, riderId, serviceDate: "2026-08-24", serviceTimezone: "America/Los_Angeles",
  localServiceTime: "08:00:00", resolvedServiceAt: "2026-08-24T15:00:00.000Z", resolvedUtcOffsetSeconds: -25200, ambiguityPolicy: "reject" });

async function seed(pool) {
  await withTenantTransaction(pool, organizationId, "kavaroutes_api", async (client) => {
    await client.query("INSERT INTO platform.organization (tenant_id,id,synthetic_name) VALUES ($1,$1,'Synthetic WP007')", [organizationId]);
    await client.query("INSERT INTO intake.rider (tenant_id,id,synthetic_reference) VALUES ($1,$2,'synthetic-rider-007')", [organizationId, riderId]);
  });
}

test("PostgreSQL create/read/cancel is tenant-safe, idempotent, conditional, audited, and atomic", { skip: !connectionString }, async () => {
  await withFreshDatabase(connectionString, "wp007_vertical", async (pool) => {
    await seed(pool);
    const etagSecret = "synthetic-etag-secret-postgres-tests-1234";
    const application = createWp007PostgresApplication(pool, { etagSecret });
    const app = await createWp007Api({ application, etagSecret });
    try {
      const firstTripId = "11111111-1111-4111-8111-111111111113";
      const createUrl = `/v1/organizations/${organizationId}/trips`;
      const createHeaders = { ...auth, "idempotency-key": "create-trip-key-0001" };
      const created = await app.inject({ method: "POST", url: createUrl, headers: createHeaders, payload: createPayload(firstTripId) });
      assert.equal(created.statusCode, 201, created.body);
      assert.equal(created.headers.location, `${createUrl}/${firstTripId}`);
      const replay = await app.inject({ method: "POST", url: createUrl, headers: createHeaders, payload: createPayload(firstTripId) });
      assert.equal(replay.statusCode, 201);
      assert.equal(replay.headers["kavaroutes-idempotency-replayed"], "true");
      assert.deepEqual(replay.json(), created.json());
      assert.equal(replay.headers.etag, created.headers.etag);
      const mismatch = await app.inject({ method: "POST", url: createUrl, headers: createHeaders, payload: { ...createPayload(firstTripId), localServiceTime: "09:00:00" } });
      assert.equal(mismatch.statusCode, 422);
      const pendingTripId = "11111111-1111-4111-8111-111111111116";
      const expiredTripId = "11111111-1111-4111-8111-111111111117";
      await withTenantTransaction(pool, organizationId, "kavaroutes_api", async (client) => {
        const insert = `INSERT INTO platform.idempotency_record
          (tenant_id,id,operation_key,request_fingerprint,result_reference,actor_reference,operation_id,state,response_status,response_body,response_headers,created_at,expires_at)
          VALUES ($1,$2,$3,$4,'pending',$5,'createTrip',$6,500,'{}','{}',$7,$8)`;
        await client.query(insert, [organizationId, "11111111-1111-4111-8111-111111111118", "create-trip-pending-1", requestFingerprint(createPayload(pendingTripId)), syntheticIds.dispatcher,
          "IN_PROGRESS", new Date(), new Date(Date.now() + 86_700_000)]);
        await client.query(insert, [organizationId, "11111111-1111-4111-8111-111111111119", "create-trip-expired-1", requestFingerprint(createPayload(expiredTripId)), syntheticIds.dispatcher,
          "COMMITTED", new Date(Date.now() - 172_800_000), new Date(Date.now() - 86_400_000)]);
      });
      assert.equal((await app.inject({ method: "POST", url: createUrl, headers: { ...auth, "idempotency-key": "create-trip-pending-1" }, payload: createPayload(pendingTripId) })).statusCode, 409);
      assert.equal((await app.inject({ method: "POST", url: createUrl, headers: { ...auth, "idempotency-key": "create-trip-expired-1" }, payload: createPayload(expiredTripId) })).statusCode, 410);

      const detailUrl = `${createUrl}/${firstTripId}`;
      const read = await app.inject({ method: "GET", url: detailUrl, headers: auth });
      assert.equal(read.statusCode, 200);
      assert.equal(read.headers.etag, created.headers.etag);
      assert.equal((await app.inject({ method: "GET", url: detailUrl, headers: { ...auth, "if-none-match": read.headers.etag } })).statusCode, 304);

      const cancelHeaders = { ...auth, "idempotency-key": "cancel-trip-key-0001", "if-match": read.headers.etag };
      const cancelled = await app.inject({ method: "POST", url: `${detailUrl}/commands/cancel`, headers: cancelHeaders,
        payload: { reasonCode: "SYNTHETIC_REQUESTER_CANCELLED" } });
      assert.equal(cancelled.statusCode, 200, cancelled.body);
      const cancelReplay = await app.inject({ method: "POST", url: `${detailUrl}/commands/cancel`, headers: cancelHeaders,
        payload: { reasonCode: "SYNTHETIC_REQUESTER_CANCELLED" } });
      assert.equal(cancelReplay.statusCode, 200, cancelReplay.body);
      assert.equal(cancelReplay.headers["kavaroutes-idempotency-replayed"], "true");
      assert.equal(cancelReplay.json().receipt.outcome, "REPLAYED");

      const secondTripId = "11111111-1111-4111-8111-111111111114";
      const second = await app.inject({ method: "POST", url: createUrl, headers: { ...auth, "idempotency-key": "create-trip-key-0002" }, payload: createPayload(secondTripId) });
      const concurrentUrl = `${createUrl}/${secondTripId}/commands/cancel`;
      const concurrent = await Promise.all([
        app.inject({ method: "POST", url: concurrentUrl, headers: { ...auth, "idempotency-key": "cancel-trip-key-0002", "if-match": second.headers.etag }, payload: { reasonCode: "SYNTHETIC_REQUESTER_CANCELLED" } }),
        app.inject({ method: "POST", url: concurrentUrl, headers: { ...auth, "idempotency-key": "cancel-trip-key-0003", "if-match": second.headers.etag }, payload: { reasonCode: "SYNTHETIC_REQUESTER_CANCELLED" } }),
      ]);
      assert.deepEqual(concurrent.map((response) => response.statusCode).sort(), [200, 412]);

      const failedTripId = "11111111-1111-4111-8111-111111111115";
      const failing = await createWp007Api({ application: createWp007PostgresApplication(pool, { etagSecret, failurePoint: "before-audit" }), etagSecret });
      try {
        assert.equal((await failing.inject({ method: "POST", url: createUrl, headers: { ...auth, "idempotency-key": "create-trip-fail-001" }, payload: createPayload(failedTripId) })).statusCode, 500);
      } finally { await failing.close(); }
      await withTenantTransaction(pool, organizationId, "kavaroutes_api", async (client) => {
        assert.equal((await client.query("SELECT count(*)::int AS count FROM intake.trip_request WHERE id=$1", [failedTripId])).rows[0].count, 0);
        assert.equal((await client.query("SELECT count(*)::int AS count FROM platform.idempotency_record WHERE operation_key='create-trip-fail-001'")).rows[0].count, 0);
        assert.equal((await client.query("SELECT count(*)::int AS count FROM audit.event WHERE aggregate_id=$1", [firstTripId])).rows[0].count, 2);
      });
    } finally { await app.close(); }
  });
});
