import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createWp007PostgresApplication, syntheticIds } from "../../api-contracts/dist/index.js";
import { withTenantTransaction } from "../../postgres-persistence/dist/index.js";
import { withFreshDatabase } from "../../postgres-persistence/scripts/database-fixture.mjs";
import { coalesceLocationBatchSignals, createDeterministicFakeTransport, createOutboxStore } from "../dist/index.js";

const connectionString = process.env.WP008_DATABASE_URL;
if (!connectionString) throw new Error("WP008_DATABASE_URL is required");
const profileFiles = ["small-pilot", "p0-growth", "enterprise-design", "commercial-platform"];
const profiles = await Promise.all(profileFiles.map(async (name) => JSON.parse(await readFile(resolve(import.meta.dirname, `../../../benchmarks/workloads/profiles/${name}.json`), "utf8"))));
const tenantIds = [syntheticIds.organizationA, "22222222-2222-4222-8222-222222222222", "33333333-3333-4333-8333-333333333333", "44444444-4444-4444-8444-444444444444"];
const riderIds = ["11111111-1111-4111-8111-111111111112", "22222222-2222-4222-8222-222222222223", "33333333-3333-4333-8333-333333333334", "44444444-4444-4444-8444-444444444445"];
const quantile = (values, fraction) => values.slice().sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * fraction))] ?? 0;
const round = (value) => Number(value.toFixed(3));

const results = await withFreshDatabase(connectionString, "wp008_benchmark", async (pool) => {
  const output = [];
  for (let profileIndex = 0; profileIndex < profiles.length; profileIndex += 1) {
    const profile = profiles[profileIndex];
    const tenantId = tenantIds[profileIndex];
    const riderId = riderIds[profileIndex];
    await withTenantTransaction(pool, tenantId, "kavaroutes_api", async (client) => {
      await client.query("INSERT INTO platform.organization (tenant_id,id,synthetic_name) VALUES ($1,$1,$2)", [tenantId, `Synthetic benchmark ${profile.id}`]);
      await client.query("INSERT INTO intake.rider (tenant_id,id,synthetic_reference) VALUES ($1,$2,$3)", [tenantId, riderId, `synthetic-${profile.id}`]);
    });
    const application = createWp007PostgresApplication(pool, { etagSecret: "synthetic-etag-secret-wp008-benchmark-1234" });
    const apiLatencies = [];
    for (let index = 0; index < 10; index += 1) {
      const tripId = `${String(profileIndex + 1).repeat(8)}-${String(profileIndex + 1).repeat(4)}-4${String(profileIndex + 1).repeat(3)}-8${String(profileIndex + 1).repeat(3)}-${String(index + 1).padStart(12, "0")}`;
      const started = performance.now();
      await application.createTrip({ organizationId: tenantId, principal: { id: syntheticIds.dispatcher, role: "dispatcher", organizationId: tenantId,
        branchIds: [], fleetIds: [], subjectId: syntheticIds.dispatcher, capabilities: ["trip:write"], purposes: ["RIDER_INTAKE"] },
        key: `wp008-${profile.id}-${String(index).padStart(4, "0")}`, request: { tripId, riderId, serviceDate: "2026-08-24",
          serviceTimezone: "America/Los_Angeles", localServiceTime: "08:00:00", resolvedServiceAt: "2026-08-24T15:00:00.000Z",
          resolvedUtcOffsetSeconds: -25200, ambiguityPolicy: "reject" } });
      apiLatencies.push(performance.now() - started);
    }
    const configuredFanout = profile.dimensions.outboundFanout.value;
    const backlogSample = Math.min(configuredFanout, 2_000);
    await withTenantTransaction(pool, tenantId, "kavaroutes_api", async (client) => {
      await client.query(`INSERT INTO outbox.message
        (tenant_id,id,event_id,aggregate_type,aggregate_id,aggregate_version,event_type,schema_version,occurred_at,command_id,
         idempotency_reference_hash,correlation_id,source,classification_reference,purpose_reference,policy_reference,payload,retain_until)
        SELECT $1,md5($2||':message:'||g)::uuid,md5($2||':event:'||g)::uuid,'TRIP_REQUEST',md5($2||':aggregate:'||g)::uuid,
          1,'TripCreated','v1',now(),md5($2||':command:'||g)::uuid,repeat('a',64),md5($2||':correlation:'||g)::uuid,
          'kavaroutes.api','REGULATED_HEALTH','RIDER_INTAKE','privacy-synthetic-v1',
          jsonb_build_object('tripId',md5($2||':aggregate:'||g)::uuid::text,'lifecycle','DRAFT','version',1),now()+interval '30 days 5 minutes'
        FROM generate_series(1,$3) g`, [tenantId, profile.id, backlogSample]);
      await client.query(`INSERT INTO outbox.delivery (tenant_id,id,message_id,route,job_type,retain_until)
        SELECT tenant_id,md5($2||':delivery:'||id::text)::uuid,id,'projection','kr.projection.trip.v1',now()+interval '30 days 5 minutes'
        FROM outbox.message WHERE tenant_id=$1 AND command_id IN
          (SELECT md5($2||':command:'||g)::uuid FROM generate_series(1,$3) g)`, [tenantId, profile.id, backlogSample]);
    });
    const store = createOutboxStore(pool);
    const claimStarted = performance.now();
    const leases = await store.claimEligible({ tenantId, publisherId: `publisher.${profile.id}`, route: "projection", limit: 100, leaseMilliseconds: 30_000 });
    const claimMs = performance.now() - claimStarted;
    const transport = createDeterministicFakeTransport();
    const publishStarted = performance.now();
    const latencies = [];
    await Promise.all(leases.map(async (lease) => {
      const started = performance.now();
      await store.publishLeased({ tenantId, publisherId: `publisher.${profile.id}`, deliveryId: lease.deliveryId, leaseVersion: lease.leaseVersion }, transport);
      latencies.push(performance.now() - started);
    }));
    const drainMs = performance.now() - publishStarted;
    await withTenantTransaction(pool, tenantId, "kavaroutes_api", async (client) => {
      const messageId = `${String(profileIndex + 5).repeat(8)}-${String(profileIndex + 5).repeat(4)}-4${String(profileIndex + 5).repeat(3)}-8${String(profileIndex + 5).repeat(3)}-999999999999`;
      const eventId = `${String(profileIndex + 5).repeat(8)}-${String(profileIndex + 5).repeat(4)}-4${String(profileIndex + 5).repeat(3)}-8${String(profileIndex + 5).repeat(3)}-888888888888`;
      const aggregateId = `${String(profileIndex + 5).repeat(8)}-${String(profileIndex + 5).repeat(4)}-4${String(profileIndex + 5).repeat(3)}-8${String(profileIndex + 5).repeat(3)}-777777777777`;
      await client.query(`INSERT INTO outbox.message
        (tenant_id,id,event_id,aggregate_type,aggregate_id,aggregate_version,event_type,schema_version,occurred_at,command_id,idempotency_reference_hash,
         correlation_id,source,classification_reference,purpose_reference,policy_reference,payload,retain_until)
        VALUES ($1::uuid,$2::uuid,$3::uuid,'TRIP_REQUEST',$4::uuid,1,'TripCreated','v1',now(),$5::uuid,repeat('f',64),$6::uuid,'kavaroutes.api','REGULATED_HEALTH','RIDER_INTAKE',
          'privacy-synthetic-v1',jsonb_build_object('tripId',($4::uuid)::text,'lifecycle','DRAFT','version',1),now()+interval '30 days 5 minutes')`,
      [tenantId, messageId, eventId, aggregateId, crypto.randomUUID(), crypto.randomUUID()]);
      await client.query(`INSERT INTO outbox.delivery (tenant_id,id,message_id,route,job_type,available_at,created_at,retain_until)
        VALUES ($1,$2,$3,'projection','kr.projection.trip.v1',now()-interval '31 seconds',now()-interval '31 seconds',now()+interval '30 days 5 minutes')`,
      [tenantId, crypto.randomUUID(), messageId]);
    });
    const health = await store.routeHealth(tenantId, "projection");
    const database = await pool.query(`SELECT blks_read,blks_hit,temp_bytes,xact_commit,
      pg_total_relation_size('outbox.delivery')::bigint AS delivery_bytes,
      (SELECT count(*)::int FROM pg_stat_activity WHERE datname=current_database()) AS connections
      FROM pg_stat_database WHERE datname=current_database()`);
    const db = database.rows[0];
    const locationSamples = Array.from({ length: Math.min(profile.dimensions.locationRate.value * 60, 60_000) }, () => ({ driverReference: riderId, aggregateReference: tenantId, windowStartedAt: "2026-08-24T12:00:00.000Z" }));
    const coalesced = coalesceLocationBatchSignals(locationSamples);
    const withinFiveSeconds = latencies.filter((value) => value <= 5_000).length / Math.max(1, latencies.length);
    assert.ok(withinFiveSeconds >= 0.99);
    assert.ok(health.oldestAgeSeconds >= 30);
    output.push({ profileId: profile.id, configured: { tenants: profile.dimensions.tenants.value, tripsPerServiceDay: profile.dimensions.trips.value,
      locationSamplesPerSecond: profile.dimensions.locationRate.value, outboundFanoutPerSecond: configuredFanout }, executedSample: { apiMutations: 10,
      readyIntents: backlogSample, publishedIntents: leases.length, locationSamples: locationSamples.length }, apiTransactionP95Ms: round(quantile(apiLatencies, 0.95)),
      claimBatchMs: round(claimMs), publishP50Ms: round(quantile(latencies, 0.50)), publishP95Ms: round(quantile(latencies, 0.95)),
      publishP99Ms: round(quantile(latencies, 0.99)), healthyPublishedWithinFiveSecondsRatio: withinFiveSeconds, recoveryDrainMs: round(drainMs),
      readyDepthAfterSample: health.depth, oldestReadyAgeSeconds: health.oldestAgeSeconds, oldestAgeAlertTriggered: health.oldestAgeSeconds >= 30,
      queueAmplificationPerApiMutation: 2, locationSignalAmplification: coalesced.length / locationSamples.length,
      database: { blocksRead: Number(db.blks_read), blocksHit: Number(db.blks_hit), tempBytes: Number(db.temp_bytes), transactionsCommitted: Number(db.xact_commit),
        deliveryBytes: Number(db.delivery_bytes), connections: db.connections } });
  }
  return output;
});
const artifact = { format: 1, environment: "local-synthetic-scaled-samples", productionCapacityClaim: false,
  limitation: "Configured ARQ-001 envelopes are recorded; execution uses bounded samples and does not prove enterprise/commercial production capacity or SLA.", profiles: results };
await writeFile(resolve(import.meta.dirname, "../artifacts/database-benchmark-results.json"), `${JSON.stringify(artifact, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(artifact, null, 2)}\n`);
