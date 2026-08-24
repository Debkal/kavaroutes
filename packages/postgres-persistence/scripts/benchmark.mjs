import { performance } from "node:perf_hooks";
import os from "node:os";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Pool } from "pg";
import { withFreshDatabase } from "./database-fixture.mjs";
import { packageRoot } from "./migration-lib.mjs";

const connectionString = process.env.WP006_DATABASE_URL;
if (!connectionString) throw new Error("WP006_DATABASE_URL is required");
const outputPath = process.env.WP006_BENCHMARK_OUTPUT ?? "/tmp/wp006-benchmark-results.json";
const catalog = JSON.parse(await readFile(resolve(packageRoot, "artifacts/query-catalog.json"), "utf8"));
const requiredProfiles = [
  { name: "small", vehicles: 25, trips: 500, legs: 1000, breadcrumbs: 60000, importItems: 2500, importShapeItems: 0 },
  { name: "p0-growth", vehicles: 75, trips: 1500, legs: 3000, breadcrumbs: 180000, importItems: 10000, importShapeItems: 250000 },
];
const extraProfiles = process.env.WP006_EXTRA_PROFILE_JSON ? JSON.parse(process.env.WP006_EXTRA_PROFILE_JSON) : [];
const requestedProfileNames = new Set((process.env.WP006_BENCHMARK_PROFILE_NAMES ?? "small,p0-growth").split(",").filter(Boolean));
const profiles = [...requiredProfiles, ...extraProfiles]
  .map((profile) => ({ importShapeItems: 0, ...profile }))
  .filter((profile) => requestedProfileNames.has(profile.name));
if (profiles.length === 0) throw new Error("WP006_BENCHMARK_PROFILE_NAMES selected no configured profile");
const declaredUnexecutedProfiles = [
  { name: "enterprise-design", vehicles: 500, trips: 10000, legs: 20000, breadcrumbs: 1200000, importItems: 100000 },
  { name: "commercial-platform", vehicles: 5000, tenants: 100, trips: 100000, legs: 200000, breadcrumbs: 12000000, importItems: 250000 },
].filter((candidate) => !profiles.some((profile) => profile.name === candidate.name));
const tenant = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const otherTenant = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const branch = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa01";
const facility = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa02";
const facilityAddress = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa03";
const area = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa04";
const batch = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa05";
const receipt = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa06";
const idem = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa07";
const uuidExpr = (prefix, series = "g") => `md5('${prefix}-' || ${series}::text)::uuid`;

function percentile(values, fraction) {
  const sorted = [...values].sort((a, b) => a - b);
  return Number(sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)].toFixed(3));
}

function summarize(values) {
  return { samples: values.length, p50Ms: percentile(values, 0.5), p95Ms: percentile(values, 0.95), p99Ms: percentile(values, 0.99), maxMs: Number(Math.max(...values).toFixed(3)) };
}

function collectPlanRelations(plan, found = []) {
  if (plan["Relation Name"]) found.push(`${plan.Schema ? `${plan.Schema}.` : ""}${plan["Relation Name"]}`);
  for (const child of plan.Plans ?? []) collectPlanRelations(child, found);
  return found;
}

async function tenantTransaction(pool, role, operation) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SET LOCAL ROLE ${role}`);
    await client.query("SELECT set_config('app.tenant_id',$1,true)", [tenant]);
    const result = await operation(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally { client.release(); }
}

async function seed(pool, profile) {
  const started = performance.now();
  await tenantTransaction(pool, "kavaroutes_api", async (client) => {
    await client.query("INSERT INTO platform.organization(tenant_id,id,synthetic_name) VALUES ($1,$1,'Synthetic Benchmark Tenant')", [tenant]);
    await client.query("INSERT INTO platform.branch(tenant_id,id,organization_id,synthetic_label) VALUES ($1,$2,$1,'Synthetic Branch')", [tenant, branch]);
    await client.query("INSERT INTO intake.address(tenant_id,id,customer_label,operational_point) VALUES ($1,$2,'Synthetic Facility Address',ST_SetSRID(ST_MakePoint(-119.5,35.5),4326)::geography)", [tenant, facilityAddress]);
    await client.query("INSERT INTO intake.facility(tenant_id,id,address_id,synthetic_label) VALUES ($1,$2,$3,'Synthetic Facility')", [tenant, facility, facilityAddress]);
    await client.query("INSERT INTO intake.service_area(tenant_id,id,synthetic_label,boundary) VALUES ($1,$2,'Synthetic Area',ST_Multi(ST_GeomFromText('POLYGON((-120 35,-119 35,-119 36,-120 36,-120 35))',4326)))", [tenant, area]);
    await client.query(`INSERT INTO intake.address(tenant_id,id,customer_label,operational_point)
      SELECT $1,${uuidExpr("address")},'Synthetic Address '||g,ST_SetSRID(ST_MakePoint(-119.9+(g%100)*0.008,35.1+(g%100)*0.008),4326)::geography FROM generate_series(1,$2) g`, [tenant, profile.trips]);
    await client.query(`INSERT INTO intake.rider(tenant_id,id,home_address_id,synthetic_reference)
      SELECT $1,${uuidExpr("rider")},${uuidExpr("address")},'synthetic-rider-'||g FROM generate_series(1,$2) g`, [tenant, profile.trips]);
    await client.query(`INSERT INTO intake.trip_request(tenant_id,id,rider_id,service_date,service_timezone,local_service_time,resolved_service_at,resolved_utc_offset_seconds,ambiguity_policy,ambiguity_policy_version,lifecycle_reference)
      SELECT $1,${uuidExpr("trip")},${uuidExpr("rider")},'2026-08-24','America/Los_Angeles','08:00','2026-08-24T15:00Z',-25200,'reject','civil-v1','accepted' FROM generate_series(1,$2) g`, [tenant, profile.trips]);
    await client.query(`INSERT INTO intake.trip_leg(tenant_id,id,trip_request_id,ordinal,origin_address_id,destination_address_id,planned_start_at,planned_end_at)
      SELECT $1,md5('leg-'||g::text||'-'||o::text)::uuid,${uuidExpr("trip")},o,${uuidExpr("address")},$3,'2026-08-24T15:00Z'::timestamptz+(g||' seconds')::interval+(o||' minutes')::interval,'2026-08-24T15:20Z'::timestamptz+(g||' seconds')::interval+(o||' minutes')::interval FROM generate_series(1,$2) g CROSS JOIN generate_series(1,2) o`, [tenant, profile.trips, facilityAddress]);
    await client.query(`INSERT INTO fleet.driver(tenant_id,id,synthetic_reference) SELECT $1,${uuidExpr("driver")},'synthetic-driver-'||g FROM generate_series(1,$2) g`, [tenant, profile.vehicles]);
    await client.query(`INSERT INTO fleet.vehicle(tenant_id,id,synthetic_reference) SELECT $1,${uuidExpr("vehicle")},'synthetic-vehicle-'||g FROM generate_series(1,$2) g`, [tenant, profile.vehicles]);
    await client.query(`INSERT INTO dispatch.run(tenant_id,id,branch_id,service_date,service_timezone,planned_start_at,planned_end_at,lifecycle_reference)
      SELECT $1,${uuidExpr("run")},$3,'2026-08-24','America/Los_Angeles','2026-08-24T14:00Z','2026-08-25T02:00Z','planned' FROM generate_series(1,$2) g`, [tenant, profile.vehicles, branch]);
    await client.query(`INSERT INTO dispatch.assignment(tenant_id,id,run_id,driver_id,vehicle_id)
      SELECT $1,${uuidExpr("assignment")},${uuidExpr("run")},${uuidExpr("driver")},${uuidExpr("vehicle")} FROM generate_series(1,$2) g`, [tenant, profile.vehicles]);
    await client.query(`INSERT INTO dispatch.resource_reservation(tenant_id,id,run_id,resource_kind,resource_id,occupied_during)
      SELECT $1,${uuidExpr("reservation")},${uuidExpr("run")},'vehicle',${uuidExpr("vehicle")},tstzrange('2026-08-24T14:00Z','2026-08-25T02:00Z','[)') FROM generate_series(1,$2) g`, [tenant, profile.vehicles]);
    await client.query(`INSERT INTO dispatch.run_leg(tenant_id,id,run_id,trip_leg_id,ordinal)
      SELECT $1,md5('run-leg-'||g::text||'-'||o::text)::uuid,md5('run-'||(((g-1)%$2)+1)::text)::uuid,md5('leg-'||g::text||'-'||o::text)::uuid,((g-1)*2+o) FROM generate_series(1,$3) g CROSS JOIN generate_series(1,2) o`, [tenant, profile.vehicles, profile.trips]);
    await client.query(`INSERT INTO realtime.location_batch_receipt(tenant_id,id,device_id,request_fingerprint,sample_count) VALUES ($1,$2,md5('device-1')::uuid,'sha256:benchmark-batch',$3)`, [tenant, batch, profile.breadcrumbs]);
    const breadcrumbStart = performance.now();
    await client.query(`INSERT INTO realtime.location_breadcrumb(tenant_id,id,batch_id,sample_index,subject_kind,subject_id,device_id,stream_epoch,sequence_number,captured_at,recorded_at,retention_due_at,retention_policy_version,position)
      SELECT $1,${uuidExpr("breadcrumb")},$2,g-1,'vehicle',md5('vehicle-'||(((g-1)%$3)+1)::text)::uuid,md5('device-'||(((g-1)%$3)+1)::text)::uuid,1,g,
        '2026-08-01T00:00Z'::timestamptz+(g||' seconds')::interval,'2026-08-01T00:00Z'::timestamptz+(g||' seconds')::interval,
        '2026-08-31T00:00Z'::timestamptz+(g||' seconds')::interval,'raw-location-30d-v1',ST_SetSRID(ST_MakePoint(-119.9+(g%100)*0.008,35.1+(g%100)*0.008),4326)::geography FROM generate_series(1,$4) g`, [tenant, batch, profile.vehicles, profile.breadcrumbs]);
    profile.breadcrumbInsertMs = performance.now() - breadcrumbStart;
    await client.query(`INSERT INTO realtime.current_position(tenant_id,subject_kind,subject_id,device_id,stream_epoch,sequence_number,captured_at,position,source_batch_id)
      SELECT $1,'vehicle',${uuidExpr("vehicle")},md5('device-'||g::text)::uuid,1,1000,'2026-08-24T16:00Z',ST_SetSRID(ST_MakePoint(-119.8+(g%25)*0.01,35.2+(g%25)*0.01),4326)::geography,$3 FROM generate_series(1,$2) g`, [tenant, profile.vehicles, batch]);
    await client.query(`INSERT INTO billing.billing_case(tenant_id,id,trip_request_id,lifecycle_reference)
      SELECT $1,${uuidExpr("billing")},${uuidExpr("trip")},CASE WHEN g%5=0 THEN 'ready' ELSE 'pending' END FROM generate_series(1,$2) g`, [tenant, profile.trips]);
    await client.query(`INSERT INTO audit.event(tenant_id,id,aggregate_kind,aggregate_id,aggregate_version,action_reference,actor_reference)
      SELECT $1,${uuidExpr("audit")},'trip_request',${uuidExpr("trip")},1,'trip.synthetic-seeded','actor:benchmark' FROM generate_series(1,$2) g`, [tenant, profile.trips]);
    await client.query("INSERT INTO integration.receipt(tenant_id,id,source_reference,request_fingerprint) VALUES ($1,$2,'synthetic-import-1','sha256:import')", [tenant, receipt]);
    await client.query("INSERT INTO platform.idempotency_record(tenant_id,id,operation_key,request_fingerprint,result_reference) VALUES ($1,$2,'benchmark-command','sha256:command',$3)", [tenant, idem, receipt]);
  });
  const importStart = performance.now();
  if (profile.importItems > 0) {
    await tenantTransaction(pool, "kavaroutes_import", (client) => client.query(`INSERT INTO integration.item(tenant_id,id,receipt_id,ordinal,outcome_reference,processed_at)
      SELECT $1,${uuidExpr("import-item")},$2,g,'accepted',now() FROM generate_series(1,$3) g`, [tenant, receipt, profile.importItems]));
  }
  const profileImportMs = performance.now() - importStart;
  const importShapeStart = performance.now();
  if (profile.importShapeItems > profile.importItems) {
    await tenantTransaction(pool, "kavaroutes_import", (client) => client.query(`INSERT INTO integration.item(tenant_id,id,receipt_id,ordinal,outcome_reference,processed_at)
      SELECT $1,${uuidExpr("import-item")},$2,g,'accepted',now() FROM generate_series($3+1,$4) g`, [tenant, receipt, profile.importItems, profile.importShapeItems]));
  }
  return {
    totalMs: Number((performance.now() - started).toFixed(3)), breadcrumbMs: Number(profile.breadcrumbInsertMs.toFixed(3)),
    breadcrumbRowsPerSecond: Number((profile.breadcrumbs / (profile.breadcrumbInsertMs / 1000)).toFixed(1)),
    profileImportMs: Number(profileImportMs.toFixed(3)), importShapeAdditionalMs: Number((performance.now() - importShapeStart).toFixed(3)),
    finalImportRows: Math.max(profile.importItems, profile.importShapeItems),
  };
}

function parameters(profile) {
  void profile;
  const run1 = "5b746968-0d99-0015-9c65-3ddb9ff22ae7";
  const vehicle1 = "99b5202f-f181-c828-d461-3571f0f67f94";
  const device1 = "d111f50a-599b-0a9f-e3ef-9e1c6b68ec88";
  const trip1 = "868c1fa9-8729-58b4-a14a-b1735185eded";
  return {
    "lookup-rider-facility": [tenant, "synthetic-rider-1", "Synthetic Facility"],
    "day-dispatch-board": [tenant, "2026-08-24"],
    "unassigned-trips": [tenant, "2026-08-24T00:00Z", "2026-08-25T00:00Z"],
    "ordered-run-manifest": [tenant, run1],
    "resource-conflict": [tenant, "vehicle", vehicle1, "[2026-08-24T15:00Z,2026-08-24T16:00Z)"],
    "nearby-current-vehicles": [tenant, -119.5, 35.5, 100000],
    "service-area-boundary": [tenant, -120, 35.5],
    "last-known-position": [tenant, "vehicle", vehicle1, device1],
    "breadcrumb-time-window": [tenant, device1, "2026-08-01T00:00Z", "2026-08-31T00:00Z"],
    "aggregate-audit-history": [tenant, "trip_request", trip1],
    "billing-ready-work": [tenant],
    "integration-duplicate": [tenant, "synthetic-import-1"],
    "idempotency-replay": [tenant, "benchmark-command"],
    "stale-version-conflict": [tenant, run1, 999],
  };
}

async function benchmarkProfile(pool, profile) {
  const seedMetrics = await seed(pool, profile);
  await pool.query("VACUUM (ANALYZE)");
  const breadcrumbPartitionCount = Number((await pool.query("SELECT count(*) AS count FROM pg_inherits WHERE inhparent='realtime.location_breadcrumb'::regclass")).rows[0].count);
  const params = parameters(profile);
  const queries = [];
  for (const query of catalog) {
    const timings = [];
    let explain;
    await tenantTransaction(pool, "kavaroutes_api", async (client) => {
      const plan = await client.query(`EXPLAIN (ANALYZE, BUFFERS, WAL, FORMAT JSON) ${query.sql}`, params[query.id]);
      explain = plan.rows[0]["QUERY PLAN"][0];
      for (let i = 0; i < 20; i += 1) {
        const start = performance.now();
        await client.query(query.sql, params[query.id]);
        timings.push(performance.now() - start);
      }
      throw Object.assign(new Error("ROLLBACK_MEASUREMENT"), { rollbackMeasurement: true });
    }).catch((error) => { if (!error.rollbackMeasurement) throw error; });
    const scannedRelations = [...new Set(collectPlanRelations(explain.Plan))];
    const scannedBreadcrumbPartitions = scannedRelations.filter((name) => name.includes("location_breadcrumb_")).length;
    queries.push({ id: query.id, kind: query.kind, coldMs: Number(explain["Execution Time"].toFixed(3)), warm: summarize(timings), plan: { planningMs: explain["Planning Time"], executionMs: explain["Execution Time"], rootNode: explain.Plan["Node Type"], actualRows: explain.Plan["Actual Rows"], sharedHitBlocks: explain.Plan["Shared Hit Blocks"], sharedReadBlocks: explain.Plan["Shared Read Blocks"], walRecords: explain.Plan["WAL Records"], scannedRelations, partitionsPruned: query.id === "breadcrumb-time-window" ? breadcrumbPartitionCount - scannedBreadcrumbPartitions : 0 } });
  }

  const concurrentStart = performance.now();
  const mixed = await Promise.allSettled(Array.from({ length: 60 }, (_, i) => i % 3 === 0
    ? tenantTransaction(pool, "kavaroutes_api", (client) => client.query(catalog[1].sql, params["day-dispatch-board"]))
    : tenantTransaction(pool, "kavaroutes_worker", (client) => client.query("SELECT realtime.advance_current_position($1,'vehicle',md5('vehicle-'||$2::text)::uuid,md5('device-'||$2::text)::uuid,1,$3,now(),now(),-119.5,35.5,$4)", [tenant, (i % profile.vehicles) + 1, 2000 + i, batch]))));
  const duplicateBatches = await Promise.all(Array.from({ length: 50 }, () => tenantTransaction(pool, "kavaroutes_worker", (client) => client.query("INSERT INTO realtime.location_batch_receipt(tenant_id,id,device_id,request_fingerprint,sample_count) VALUES ($1,md5(random()::text)::uuid,md5('duplicate-device')::uuid,'sha256:duplicate',0) ON CONFLICT (tenant_id,device_id,request_fingerprint) DO NOTHING", [tenant]))));
  const poolReuse = await tenantTransaction(pool, "kavaroutes_api", async (client) => {
    await client.query("SAVEPOINT before_other");
    await client.query("SELECT set_config('app.tenant_id',$1,true)", [otherTenant]);
    const hidden = (await client.query("SELECT count(*)::int AS count FROM platform.organization")).rows[0].count;
    await client.query("ROLLBACK TO before_other");
    const restored = (await client.query("SELECT count(*)::int AS count FROM platform.organization")).rows[0].count;
    return { hidden, restored };
  });
  const retention = await tenantTransaction(pool, "kavaroutes_worker", (client) => client.query("SELECT * FROM realtime.plan_breadcrumb_retention('2026-10-01T00:00Z')"));
  const sizes = await pool.query(`SELECT n.nspname AS schema, c.relname AS relation, pg_total_relation_size(c.oid)::bigint AS total_bytes, pg_indexes_size(c.oid)::bigint AS index_bytes
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=ANY($1) AND c.relkind IN ('r','p') ORDER BY pg_total_relation_size(c.oid) DESC LIMIT 20`, [["intake","dispatch","realtime","integration","audit","billing"]]);
  const stats = await pool.query(`SELECT schemaname AS schema, relname AS relation, n_live_tup, n_dead_tup, last_analyze, analyze_count, vacuum_count FROM pg_stat_user_tables WHERE schemaname=ANY($1) ORDER BY n_live_tup DESC LIMIT 20`, [["intake","dispatch","realtime","integration","audit","billing"]]);
  const statementStats = await pool.query("SELECT calls, mean_exec_time, rows, shared_blks_hit, shared_blks_read, wal_records FROM pg_stat_statements WHERE query LIKE '%tenant_id%' ORDER BY total_exec_time DESC LIMIT 20");
  const locks = await pool.query("SELECT mode, granted, count(*)::int AS count FROM pg_locks WHERE database=(SELECT oid FROM pg_database WHERE datname=current_database()) GROUP BY mode,granted ORDER BY mode,granted");
  const reads = queries.filter((query) => query.kind === "read").flatMap((query) => [query.warm.p95Ms]);
  const commands = queries.filter((query) => query.kind === "command").flatMap((query) => [query.warm.p95Ms]);
  return {
    profile: { ...profile, breadcrumbInsertMs: undefined }, seed: seedMetrics, queries,
    mixedReadWrite: { operations: mixed.length, rejected: mixed.filter((entry) => entry.status === "rejected").length, elapsedMs: Number((performance.now() - concurrentStart).toFixed(3)) },
    duplicateBatchAttempts: duplicateBatches.length, crossTenantPoolReuse: poolReuse,
    retentionPartitions: retention.rows, sizes: sizes.rows, vacuumAnalyze: stats.rows, pgStatStatements: statementStats.rows,
    locks: locks.rows, gates: { indexedReadP95LimitMs: 100, authoritativeCommandP95LimitMs: 250, observedMaxReadP95Ms: Math.max(...reads), observedMaxCommandP95Ms: Math.max(...commands), passed: Math.max(...reads) <= 100 && Math.max(...commands) <= 250 },
  };
}

const results = [];
for (const profile of profiles) {
  results.push(await withFreshDatabase(connectionString, `benchmark_${profile.name.replaceAll("-", "_")}`, (pool) => benchmarkProfile(pool, profile)));
}
const control = new Pool({ connectionString, max: 1 });
const versions = await control.query("SELECT current_setting('server_version') AS postgres, postgis_lib_version() AS postgis");
const settings = await control.query("SELECT name, setting, unit FROM pg_settings WHERE name IN ('max_connections','shared_buffers','work_mem','effective_cache_size','track_io_timing','shared_preload_libraries','TimeZone') ORDER BY name");
await control.end();
const artifact = {
  format: 1, generatedAt: new Date().toISOString(),
  environment: { hostname: os.hostname(), platform: os.platform(), release: os.release(), architecture: os.arch(), cpuModel: os.cpus()[0]?.model, logicalCpuCount: os.cpus().length, memoryBytes: os.totalmem(), node: process.version, database: versions.rows[0], settings: settings.rows, image: "postgis/postgis:17-3.5@sha256:624f5195b91d424dbebf018890148cc0e5a3e80db5467da8b53cc2ed2ce49216" },
  scope: { data: "synthetic-only", rls: true, claims: "local component evidence only; not a production capacity claim", declaredUnexecutedProfiles, extraProfileConfiguration: "Set WP006_EXTRA_PROFILE_JSON to a JSON array; non-required profiles remain unproven until actually run." },
  results,
};
await writeFile(outputPath, `${JSON.stringify(artifact, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({ outputPath, profiles: results.map((result) => ({ profile: result.profile, seed: result.seed, mixedReadWrite: result.mixedReadWrite, gates: result.gates })) }, null, 2)}\n`);
if (!results.every((result) => result.gates.passed)) process.exitCode = 1;
