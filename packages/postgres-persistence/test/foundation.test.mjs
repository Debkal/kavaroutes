import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { createPostgresPersistence, PersistenceConflict, withTenantTransaction } from "../dist/index.js";
import { withFreshDatabase } from "../scripts/database-fixture.mjs";
import { applyMigrations } from "../scripts/migration-lib.mjs";

const connectionString = process.env.WP006_DATABASE_URL;
if (!connectionString) throw new Error("WP006_DATABASE_URL is required; start infra/wp006/compose.yaml first");

const ids = {
  a: "11111111-1111-4111-8111-111111111111",
  b: "22222222-2222-4222-8222-222222222222",
  c: "77777777-7777-7777-8777-777777777777",
  branch: "11111111-1111-4111-8111-111111111112",
  addressA: "11111111-1111-4111-8111-111111111113",
  addressB: "11111111-1111-4111-8111-111111111114",
  rider: "11111111-1111-4111-8111-111111111115",
  trip: "11111111-1111-4111-8111-111111111116",
  leg: "11111111-1111-4111-8111-111111111117",
  runA: "11111111-1111-4111-8111-111111111118",
  runB: "11111111-1111-4111-8111-111111111119",
  driver: "11111111-1111-4111-8111-111111111120",
  vehicle: "11111111-1111-4111-8111-111111111123",
  assignment: "11111111-1111-4111-8111-111111111124",
  shiftSnapshot: "11111111-1111-4111-8111-111111111125",
  shiftGeneration: "11111111-1111-4111-8111-111111111126",
  device: "11111111-1111-4111-8111-111111111121",
  batch: "11111111-1111-4111-8111-111111111122",
};

async function seedTenant(pool, tenantId, suffix) {
  await withTenantTransaction(pool, tenantId, "kavaroutes_api", async (client) => {
    await client.query("INSERT INTO platform.organization (tenant_id, id, synthetic_name) VALUES ($1, $1, $2)", [tenantId, `Synthetic ${suffix}`]);
  });
}

test("clean replay, WP005 upgrade replay, and migration replay are deterministic", async () => {
  await withFreshDatabase(connectionString, "replay", async (pool) => {
    const client = await pool.connect();
    try {
      await applyMigrations(client);
      assert.equal((await client.query("SELECT count(*)::int AS count FROM public.kavaroutes_schema_migration")).rows[0].count, 10);
      assert.equal((await client.query("SELECT platform.assert_tenant_boundaries() AS result")).rowCount, 1);
    } finally { client.release(); }
  }, async (pool) => {
    await pool.query("CREATE SCHEMA wp005_test");
    await pool.query("CREATE TABLE wp005_test.synthetic_probe (id text PRIMARY KEY)");
  });
});

test("forced RLS fails closed across missing, malformed, stale, owner, and pooled tenant context", async () => {
  await withFreshDatabase(connectionString, "rls", async (pool) => {
    await seedTenant(pool, ids.a, "Tenant A");
    await seedTenant(pool, ids.b, "Tenant B");
    await seedTenant(pool, ids.c, "Tenant UUIDv7");

    assert.equal(await withTenantTransaction(pool, ids.a, "kavaroutes_api", async (client) =>
      (await client.query("SELECT count(*)::int AS count FROM platform.organization")).rows[0].count), 1);
    assert.equal(await withTenantTransaction(pool, ids.b, "kavaroutes_worker", async (client) =>
      (await client.query("SELECT count(*)::int AS count FROM platform.organization")).rows[0].count), 1);
    assert.equal(await withTenantTransaction(pool, ids.c, "kavaroutes_api", async (client) =>
      (await client.query("SELECT count(*)::int AS count FROM platform.organization")).rows[0].count), 1);
    await assert.rejects(() => withTenantTransaction(pool, ids.a, "kavaroutes_import", (client) =>
      client.query({ name: "tenant-organization-by-guessed-id", text: "SELECT count(*)::int AS count FROM platform.organization WHERE id=$1", values: [ids.b] })),
    (error) => error instanceof PersistenceConflict && error.kind === "tenant");
    await assert.rejects(() => withTenantTransaction(pool, ids.a, "kavaroutes_api", async (client) => {
      await client.query("SET LOCAL row_security=off");
      return client.query("SELECT * FROM platform.organization");
    }), PersistenceConflict);

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE kavaroutes_api");
      assert.equal((await client.query("SELECT count(*)::int AS count FROM platform.organization")).rows[0].count, 0);
      await client.query("SELECT set_config('app.tenant_id', 'malformed', true)");
      assert.equal((await client.query("SELECT count(*)::int AS count FROM platform.organization")).rows[0].count, 0);
      await client.query("ROLLBACK");
      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE kavaroutes_api");
      assert.equal((await client.query("SELECT current_setting('app.tenant_id', true) AS tenant")).rows[0].tenant, "");
      assert.equal((await client.query("SELECT count(*)::int AS count FROM platform.organization")).rows[0].count, 0);
      await client.query("ROLLBACK");

      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE kavaroutes_migration");
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [ids.a]);
      assert.equal((await client.query("SELECT count(*)::int AS count FROM platform.organization")).rows[0].count, 1);
      await client.query("ROLLBACK");
    } finally { client.release(); }

    const roles = await pool.query("SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname LIKE 'kavaroutes_%' ORDER BY rolname");
    assert.ok(roles.rows.every((row) => !row.rolsuper && !row.rolbypassrls));
  });
});

test("driver tier authority defaults strict and pins an immutable tenant-scoped shift policy", async () => {
  await withFreshDatabase(connectionString, "driver_policy", async (pool) => {
    await seedTenant(pool, ids.a, "Policy A");
    await seedTenant(pool, ids.b, "Policy B");

    await withTenantTransaction(pool, ids.a, "kavaroutes_api", async (client) => {
      const organization = (await client.query("SELECT commercial_tier FROM platform.organization")).rows[0];
      assert.equal(organization.commercial_tier, "ENTERPRISE");
      const seededPolicy = (await client.query("SELECT policy_version,controls,locks,lifecycle FROM platform.driver_control_policy")).rows[0];
      assert.equal(Number(seededPolicy.policy_version), 1);
      assert.equal(seededPolicy.lifecycle, "ACTIVE");
      assert.equal(seededPolicy.controls.preInspection, "REQUIRED");
      assert.equal(seededPolicy.locks.preInspection, true);

      await client.query("INSERT INTO platform.branch (tenant_id,id,organization_id,synthetic_label) VALUES ($1,$2,$1,'Policy Branch')", [ids.a, ids.branch]);
      await client.query("INSERT INTO fleet.driver (tenant_id,id,synthetic_reference) VALUES ($1,$2,'policy-driver')", [ids.a, ids.driver]);
      await client.query("INSERT INTO fleet.vehicle (tenant_id,id,synthetic_reference) VALUES ($1,$2,'policy-vehicle')", [ids.a, ids.vehicle]);
      await client.query("INSERT INTO dispatch.run (tenant_id,id,branch_id,service_date,service_timezone,planned_start_at,planned_end_at,lifecycle_reference) VALUES ($1,$2,$3,'2026-08-28','UTC','2026-08-28T10:00Z','2026-08-28T12:00Z','planned')", [ids.a, ids.runA, ids.branch]);
      await client.query("INSERT INTO dispatch.assignment (tenant_id,id,run_id,driver_id,vehicle_id) VALUES ($1,$2,$3,$4,$5)", [ids.a, ids.assignment, ids.runA, ids.driver, ids.vehicle]);
      assert.equal((await client.query("SELECT workforce_relationship FROM fleet.driver WHERE id=$1", [ids.driver])).rows[0].workforce_relationship, "EMPLOYEE");

      const effectivePolicy = {
        schemaVersion: 1, commercialTier: "ENTERPRISE", workforceRelationship: "EMPLOYEE",
        preInspection: { mode: "REQUIRED", locked: true },
      };
      await client.query(`INSERT INTO execution.shift_policy_snapshot (
        tenant_id,id,assignment_id,driver_id,shift_generation,policy_version,policy_digest,effective_policy
      ) VALUES ($1,$2,$3,$4,$5,1,$6,$7::jsonb)`, [ids.a, ids.shiftSnapshot, ids.assignment, ids.driver, ids.shiftGeneration, "a".repeat(64), JSON.stringify(effectivePolicy)]);

      await client.query("UPDATE platform.organization SET commercial_tier='SMALL_BUSINESS' WHERE id=$1", [ids.a]);
      await client.query("UPDATE dispatch.assignment SET workforce_relationship='OWNER_OPERATOR' WHERE id=$1", [ids.assignment]);
      const pinned = (await client.query("SELECT policy_digest,effective_policy FROM execution.shift_policy_snapshot WHERE id=$1", [ids.shiftSnapshot])).rows[0];
      assert.equal(pinned.policy_digest, "a".repeat(64));
      assert.equal(pinned.effective_policy.commercialTier, "ENTERPRISE");

      await client.query("UPDATE execution.shift_policy_snapshot SET lifecycle='INVALIDATE_REVIEW',invalidated_at=now(),invalidation_reason_code='CRITICAL_EXTERNAL_RULE' WHERE id=$1", [ids.shiftSnapshot]);
    });

    await assert.rejects(() => withTenantTransaction(pool, ids.a, "kavaroutes_api", (client) =>
      client.query("UPDATE execution.shift_policy_snapshot SET policy_digest=$1 WHERE id=$2", ["b".repeat(64), ids.shiftSnapshot])), /SHIFT_POLICY_SNAPSHOT_IMMUTABLE/);

    const persistence = createPostgresPersistence(pool);
    const policyId = randomUUID(); const commandId = randomUUID(); const messageId = randomUUID(); const occurredAt = new Date();
    const mutationInput = { tenantId: ids.a, actorReference: ids.driver, operationId: "updateDriverControlPolicy", key: "driver-policy-update-0001",
      fingerprint: "d".repeat(64), recordId: randomUUID(), expiresAt: new Date(occurredAt.getTime() + 25 * 3_600_000) };
    const updatePolicy = (transaction) => transaction.replaceDriverControlPolicy({ policyId, organizationId: ids.a, expectedVersion: 1,
      controls: { preInspection: "OPTIONAL", postInspection: "OPTIONAL", startOdometer: "OPTIONAL", endOdometer: "OPTIONAL", returnVerification: "ADVISORY", routeChange: "DISPATCH_APPROVAL_REQUIRED" },
      locks: { preInspection: false, postInspection: false, startOdometer: false, endOdometer: false, returnVerification: false, routeChange: true },
      reasonCode: "OPERATING_POLICY_CHANGED", actorId: ids.driver }).then(async (policy) => {
        await transaction.appendAudit({ auditId: randomUUID(), aggregateKind: "driver-control-policy", aggregateId: policy.policyId,
          aggregateVersion: policy.version, actionReference: "driver.policy.updated", actorReference: ids.driver });
        await transaction.appendOutboxMessage({ messageId, eventId: randomUUID(), aggregateType: "DRIVER_POLICY", aggregateId: policy.policyId,
          aggregateVersion: policy.version, eventType: "DriverPolicyUpdated", schemaVersion: "v1", occurredAt, commandId,
          idempotencyReferenceHash: "e".repeat(64), correlationId: commandId, source: "kavaroutes.api", classificationReference: "OPERATIONS",
          purposeReference: "ASSIGNED_SERVICE_DELIVERY", policyReference: "driver-policy-v1", payload: { organizationId: ids.a, policyVersion: policy.version },
          retainUntil: new Date(occurredAt.getTime() + 31 * 86_400_000) });
        await transaction.appendOutboxDelivery({ deliveryId: randomUUID(), messageId, route: "projection", jobType: "kr.driver-policy.project.v1",
          availableAt: occurredAt, retainUntil: new Date(occurredAt.getTime() + 31 * 86_400_000) });
        return { statusCode: 200, body: policy, headers: { etag: '"synthetic-policy-v2"' }, resultReference: policy.policyId };
      });
    const committed = await persistence.executeIdempotentMutation(mutationInput, updatePolicy);
    const replayed = await persistence.executeIdempotentMutation({ ...mutationInput, recordId: randomUUID() }, updatePolicy);
    assert.equal(committed.replayed, false); assert.equal(replayed.replayed, true); assert.deepEqual(replayed.body, committed.body);
    await withTenantTransaction(pool, ids.a, "kavaroutes_api", async (client) => {
      assert.equal((await client.query("SELECT count(*)::int AS count FROM platform.driver_control_policy WHERE lifecycle='ACTIVE' AND policy_version=2")).rows[0].count, 1);
      assert.equal((await client.query("SELECT count(*)::int AS count FROM audit.event WHERE action_reference='driver.policy.updated'")).rows[0].count, 1);
      assert.equal((await client.query("SELECT count(*)::int AS count FROM outbox.message WHERE event_type='DriverPolicyUpdated'")).rows[0].count, 1);
    });
    assert.equal(await withTenantTransaction(pool, ids.b, "kavaroutes_api", async (client) =>
      (await client.query("SELECT count(*)::int AS count FROM execution.shift_policy_snapshot")).rows[0].count), 0);
    await assert.rejects(() => withTenantTransaction(pool, ids.b, "kavaroutes_api", (client) =>
      client.query(`INSERT INTO execution.shift_policy_snapshot (
        tenant_id,id,assignment_id,driver_id,shift_generation,policy_version,policy_digest,effective_policy
      ) VALUES ($1,$2,$3,$4,$5,1,$6,'{}'::jsonb)`, [ids.b, randomUUID(), ids.assignment, ids.driver, randomUUID(), "c".repeat(64)])), PersistenceConflict);
  });
});

test("tenant-qualified foreign keys, optimistic versions, idempotency, and same-transaction audit hold", async () => {
  await withFreshDatabase(connectionString, "commands", async (pool) => {
    const persistence = createPostgresPersistence(pool);
    await persistence.createSyntheticOrganization({ tenantId: ids.a, name: "Synthetic A", actor: "actor:synthetic" });
    await seedTenant(pool, ids.b, "Tenant B");
    await withTenantTransaction(pool, ids.a, "kavaroutes_api", async (client) => {
      await client.query("INSERT INTO platform.branch (tenant_id,id,organization_id,synthetic_label) VALUES ($1,$2,$1,'Synthetic Branch')", [ids.a, ids.branch]);
      await client.query("INSERT INTO dispatch.run (tenant_id,id,branch_id,service_date,service_timezone,planned_start_at,planned_end_at,lifecycle_reference) VALUES ($1,$2,$3,'2026-08-24','America/Los_Angeles','2026-08-24T15:00Z','2026-08-24T17:00Z','planned')", [ids.a, ids.runA, ids.branch]);
    });
    await assert.rejects(() => withTenantTransaction(pool, ids.b, "kavaroutes_api", (client) =>
      client.query("INSERT INTO platform.branch (tenant_id,id,organization_id,synthetic_label) VALUES ($1,$2,$3,'Cross Tenant')", [ids.b, randomUUID(), ids.a])), PersistenceConflict);

    assert.deepEqual(await persistence.updateRunExpectedVersion({ tenantId: ids.a, runId: ids.runA, expectedVersion: 1, lifecycleReference: "dispatched", actor: "actor:synthetic" }), { version: 2 });
    await assert.rejects(() => persistence.updateRunExpectedVersion({ tenantId: ids.a, runId: ids.runA, expectedVersion: 1, lifecycleReference: "stale", actor: "actor:synthetic" }), (error) => error instanceof PersistenceConflict && error.kind === "stale-version");
    const concurrent = await Promise.allSettled([
      persistence.updateRunExpectedVersion({ tenantId: ids.a, runId: ids.runA, expectedVersion: 2, lifecycleReference: "concurrent-a", actor: "actor:synthetic" }),
      persistence.updateRunExpectedVersion({ tenantId: ids.a, runId: ids.runA, expectedVersion: 2, lifecycleReference: "concurrent-b", actor: "actor:synthetic" }),
    ]);
    assert.equal(concurrent.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(concurrent.filter((result) => result.status === "rejected" && result.reason instanceof PersistenceConflict && result.reason.kind === "stale-version").length, 1);
    assert.equal(await withTenantTransaction(pool, ids.a, "kavaroutes_api", async (client) =>
      (await client.query("SELECT count(*)::int AS count FROM audit.event WHERE aggregate_id=$1", [ids.runA])).rows[0].count), 2);

    const keyId = randomUUID();
    assert.equal((await persistence.rememberIdempotentResult({ tenantId: ids.a, id: keyId, operationKey: "synthetic-command-1", fingerprint: "sha256:aaa", resultReference: ids.runA })).replayed, false);
    assert.equal((await persistence.rememberIdempotentResult({ tenantId: ids.a, id: randomUUID(), operationKey: "synthetic-command-1", fingerprint: "sha256:aaa", resultReference: ids.runA })).replayed, true);
    await assert.rejects(() => persistence.rememberIdempotentResult({ tenantId: ids.a, id: randomUUID(), operationKey: "synthetic-command-1", fingerprint: "sha256:bbb", resultReference: ids.runA }), PersistenceConflict);
  });
});

test("civil time resolution rejects gaps, resolves folds explicitly, and preserves cross-midnight/display semantics", async () => {
  await withFreshDatabase(connectionString, "time", async (pool) => {
    await assert.rejects(() => pool.query("SELECT platform.resolve_civil_instant('2026-03-08 02:30', 'America/Los_Angeles', 'reject')"), /NONEXISTENT_CIVIL_TIME/);
    await assert.rejects(() => pool.query("SELECT platform.resolve_civil_instant('2026-11-01 01:30', 'America/Los_Angeles', 'reject')"), /AMBIGUOUS_CIVIL_TIME/);
    const fold = await pool.query("SELECT platform.resolve_civil_instant('2026-11-01 01:30', 'America/Los_Angeles', 'earlier') AS earlier, platform.resolve_civil_instant('2026-11-01 01:30', 'America/Los_Angeles', 'later') AS later");
    assert.equal((fold.rows[0].later - fold.rows[0].earlier) / 3600000, 1);
    const display = await pool.query("SELECT to_char('2026-08-25T06:30:00Z'::timestamptz AT TIME ZONE 'America/Los_Angeles','YYYY-MM-DD') AS service_day, to_char('2026-08-25T06:30:00Z'::timestamptz AT TIME ZONE 'America/New_York','YYYY-MM-DD') AS viewer_day");
    assert.equal(display.rows[0].service_day, "2026-08-24");
    assert.equal(display.rows[0].viewer_day, "2026-08-25");
  });
});

test("spatial boundaries are inclusive and meter-radius lookup uses geography", async () => {
  await withFreshDatabase(connectionString, "spatial", async (pool) => {
    await seedTenant(pool, ids.a, "Spatial");
    await withTenantTransaction(pool, ids.a, "kavaroutes_api", async (client) => {
      await client.query("INSERT INTO intake.service_area (tenant_id,id,synthetic_label,boundary) VALUES ($1,$2,'Synthetic Square',ST_Multi(ST_GeomFromText('POLYGON((-120 35,-119 35,-119 36,-120 36,-120 35))',4326)))", [ids.a, randomUUID()]);
      await client.query("INSERT INTO realtime.current_position (tenant_id,subject_kind,subject_id,device_id,stream_epoch,sequence_number,captured_at,position) VALUES ($1,'vehicle',$2,$3,1,1,now(),ST_SetSRID(ST_MakePoint(-119.5,35.5),4326)::geography)", [ids.a, randomUUID(), ids.device]);
      assert.equal((await client.query("SELECT ST_Covers(boundary, ST_SetSRID(ST_MakePoint(-120,35.5),4326)) AS covered FROM intake.service_area")).rows[0].covered, true);
      assert.equal((await client.query("SELECT count(*)::int AS count FROM realtime.current_position WHERE ST_DWithin(position,ST_SetSRID(ST_MakePoint(-119.5001,35.5),4326)::geography,100)")).rows[0].count, 1);
    });
  });
});

test("half-open reservations reject different-run overlap while run manifests allow multiple passengers", async () => {
  await withFreshDatabase(connectionString, "reservation", async (pool) => {
    await seedTenant(pool, ids.a, "Dispatch");
    await withTenantTransaction(pool, ids.a, "kavaroutes_api", async (client) => {
      await client.query("INSERT INTO platform.branch (tenant_id,id,organization_id,synthetic_label) VALUES ($1,$2,$1,'Synthetic Branch')", [ids.a, ids.branch]);
      for (const runId of [ids.runA, ids.runB]) await client.query("INSERT INTO dispatch.run (tenant_id,id,branch_id,service_date,service_timezone,planned_start_at,planned_end_at,lifecycle_reference) VALUES ($1,$2,$3,'2026-08-24','UTC','2026-08-24T10:00Z','2026-08-24T12:00Z','planned')", [ids.a, runId, ids.branch]);
      await client.query("INSERT INTO dispatch.resource_reservation (tenant_id,id,run_id,resource_kind,resource_id,occupied_during) VALUES ($1,$2,$3,'driver',$4,tstzrange('2026-08-24T10:00Z','2026-08-24T11:00Z','[)'))", [ids.a, randomUUID(), ids.runA, ids.driver]);
      await client.query("INSERT INTO dispatch.resource_reservation (tenant_id,id,run_id,resource_kind,resource_id,occupied_during) VALUES ($1,$2,$3,'driver',$4,tstzrange('2026-08-24T11:00Z','2026-08-24T12:00Z','[)'))", [ids.a, randomUUID(), ids.runB, ids.driver]);
      await client.query("INSERT INTO intake.address(tenant_id,id,customer_label) VALUES ($1,$2,'Synthetic A'),($1,$3,'Synthetic B')", [ids.a, ids.addressA, ids.addressB]);
      await client.query("INSERT INTO intake.rider(tenant_id,id,synthetic_reference) VALUES ($1,$2,'synthetic-rider')", [ids.a, ids.rider]);
      await client.query("INSERT INTO intake.trip_request(tenant_id,id,rider_id,service_date,service_timezone,local_service_time,resolved_service_at,resolved_utc_offset_seconds,ambiguity_policy,ambiguity_policy_version,lifecycle_reference) VALUES ($1,$2,$3,'2026-08-24','UTC','10:00','2026-08-24T10:00Z',0,'reject','civil-v1','accepted')", [ids.a, ids.trip, ids.rider]);
      await client.query("INSERT INTO intake.trip_leg(tenant_id,id,trip_request_id,ordinal,origin_address_id,destination_address_id,planned_start_at,planned_end_at) VALUES ($1,$2,$3,1,$4,$5,'2026-08-24T10:00Z','2026-08-24T10:20Z'),($1,$6,$3,2,$5,$4,'2026-08-24T10:30Z','2026-08-24T10:50Z')", [ids.a, ids.leg, ids.trip, ids.addressA, ids.addressB, randomUUID()]);
      await client.query("INSERT INTO dispatch.run_leg(tenant_id,id,run_id,trip_leg_id,ordinal) SELECT tenant_id,md5('test-run-leg-'||id::text)::uuid,$1,id,ordinal FROM intake.trip_leg WHERE tenant_id=$2", [ids.runA, ids.a]);
      assert.equal((await client.query("SELECT count(*)::int AS count FROM dispatch.run_leg WHERE run_id=$1", [ids.runA])).rows[0].count, 2);
    });
    await assert.rejects(() => withTenantTransaction(pool, ids.a, "kavaroutes_api", (client) => client.query("INSERT INTO dispatch.resource_reservation (tenant_id,id,run_id,resource_kind,resource_id,occupied_during) VALUES ($1,$2,$3,'driver',$4,tstzrange('2026-08-24T10:30Z','2026-08-24T11:30Z','[)'))", [ids.a, randomUUID(), ids.runB, ids.driver])), (error) => error instanceof PersistenceConflict && error.kind === "resource-overlap");
  });
});

test("GPS history is append-only/idempotent, current position never regresses, partitions prune, and retention is dry-run/hold-aware", async () => {
  await withFreshDatabase(connectionString, "gps", async (pool) => {
    const persistence = createPostgresPersistence(pool);
    await seedTenant(pool, ids.a, "Realtime");
    await withTenantTransaction(pool, ids.a, "kavaroutes_worker", async (client) => {
      await client.query("INSERT INTO realtime.location_batch_receipt (tenant_id,id,device_id,request_fingerprint,sample_count) VALUES ($1,$2,$3,'sha256:batch',2)", [ids.a, ids.batch, ids.device]);
      await client.query(`INSERT INTO realtime.location_breadcrumb (tenant_id,id,batch_id,sample_index,subject_kind,subject_id,device_id,stream_epoch,sequence_number,captured_at,recorded_at,retention_due_at,retention_policy_version,legal_hold,position)
        VALUES ($1,$2,$3,0,'vehicle',$4,$5,1,1,'2026-07-20T10:00Z','2026-07-20T10:00Z','2026-08-19T10:00Z','raw-location-30d-v1',false,ST_SetSRID(ST_MakePoint(-119.5,35.5),4326)::geography),
               ($1,$6,$3,1,'vehicle',$4,$5,1,2,'2026-07-20T10:01Z','2026-07-20T10:01Z','2026-08-19T10:01Z','raw-location-30d-v1',true,ST_SetSRID(ST_MakePoint(-119.5,35.5),4326)::geography)`, [ids.a, randomUUID(), ids.batch, ids.runA, ids.device, randomUUID()]);
      assert.equal((await client.query("INSERT INTO realtime.location_batch_receipt(tenant_id,id,device_id,request_fingerprint,sample_count) VALUES ($1,$2,$3,'sha256:batch',2) ON CONFLICT (tenant_id,device_id,request_fingerprint) DO NOTHING", [ids.a, randomUUID(), ids.device])).rowCount, 0);
    });
    assert.equal(await persistence.advanceCurrentPosition({ tenantId: ids.a, subjectKind: "vehicle", subjectId: ids.runA, deviceId: ids.device, streamEpoch: 1, sequenceNumber: 2, capturedAt: new Date("2026-08-24T10:02Z"), recordedAt: new Date("2026-08-24T10:02Z"), longitude: -119.5, latitude: 35.5, sourceBatchId: ids.batch }), true);
    assert.equal(await persistence.advanceCurrentPosition({ tenantId: ids.a, subjectKind: "vehicle", subjectId: ids.runA, deviceId: ids.device, streamEpoch: 1, sequenceNumber: 1, capturedAt: new Date("2026-08-24T10:01Z"), recordedAt: new Date("2026-08-24T10:03Z"), longitude: -119.6, latitude: 35.6, sourceBatchId: ids.batch }), false);
    await withTenantTransaction(pool, ids.a, "kavaroutes_worker", async (client) => {
      assert.equal(Number((await client.query("SELECT sequence_number FROM realtime.current_position")).rows[0].sequence_number), 2);
      const retention = await client.query("SELECT * FROM realtime.plan_breadcrumb_retention('2026-08-24T00:00Z')");
      assert.equal(Number(retention.rows[0].eligible_rows), 1);
      assert.equal(Number(retention.rows[0].held_rows), 1);
      assert.equal(retention.rows[0].dry_run, true);
      const plan = await client.query("EXPLAIN (FORMAT JSON) SELECT * FROM realtime.location_breadcrumb WHERE tenant_id=$1 AND recorded_at >= '2026-07-01' AND recorded_at < '2026-08-01'", [ids.a]);
      const planText = JSON.stringify(plan.rows[0]);
      assert.ok(planText.includes("location_breadcrumb_2026_07"));
      assert.ok(!planText.includes("location_breadcrumb_2026_08"));
      assert.equal((await client.query("SELECT count(*)::int AS count FROM information_schema.columns WHERE table_schema='realtime' AND table_name='current_position' AND column_name IN ('arrival','pickup','dropoff','completion','billing_ready')")).rows[0].count, 0);
    });
    const quarantineId = randomUUID();
    const admin = await pool.connect();
    try {
      await admin.query("BEGIN");
      await admin.query("ALTER TABLE realtime.location_breadcrumb DETACH PARTITION realtime.location_breadcrumb_2026_07");
      assert.equal((await admin.query("SELECT count(*)::int AS count FROM realtime.location_breadcrumb_2026_07")).rows[0].count, 2);
      assert.equal((await admin.query("SELECT count(*)::int AS count FROM realtime.location_breadcrumb WHERE recorded_at >= '2026-07-01' AND recorded_at < '2026-08-01'")).rows[0].count, 0);
      await admin.query("INSERT INTO realtime.retention_quarantine(tenant_id,id,partition_name,policy_version,eligible_rows,held_rows) VALUES ($1,$2,'realtime.location_breadcrumb_2026_07','raw-location-30d-v1',1,1)", [ids.a, quarantineId]);
      await admin.query("ALTER TABLE realtime.location_breadcrumb ATTACH PARTITION realtime.location_breadcrumb_2026_07 FOR VALUES FROM ('2026-07-01') TO ('2026-08-01')");
      await admin.query("UPDATE realtime.retention_quarantine SET reconciled_at=now() WHERE tenant_id=$1 AND id=$2", [ids.a, quarantineId]);
      await admin.query("COMMIT");
      assert.equal((await admin.query("SELECT count(*)::int AS count FROM realtime.location_breadcrumb WHERE recorded_at >= '2026-07-01' AND recorded_at < '2026-08-01'")).rows[0].count, 2);
      assert.equal((await admin.query("SELECT count(*)::int AS count FROM realtime.location_breadcrumb WHERE legal_hold")).rows[0].count, 1);
    } catch (error) {
      await admin.query("ROLLBACK");
      throw error;
    } finally { admin.release(); }
  });
});
