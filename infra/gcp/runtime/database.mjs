import { Pool } from 'pg';
import { PgBoss } from 'pg-boss';
import { applyMigrations, readMigrations } from '../../../packages/postgres-persistence/scripts/migration-lib.mjs';
import { withTenantTransaction } from '@kavaroutes/postgres-persistence';
import { ROUTE_POLICIES } from '@kavaroutes/durable-execution';
import { schema, tenantId, riderId, routes, validateConfig } from './config.mjs';

const memberships = { api: ['kavaroutes_api','kavaroutes_realtime'], worker: ['kavaroutes_outbox_consumer','kavaroutes_outbox_publisher'] };
let migrationManifest;
async function verifyMemberships(pool, role, allowMissing = false) {
  const result = await pool.query(`SELECT r.rolname FROM pg_roles r WHERE r.rolname <> $1
    AND pg_has_role($1,r.oid,'MEMBER') ORDER BY r.rolname`, [`kr_cloud_${role}`]);
  const names = result.rows.map(row => row.rolname);
  if (names.some(name => !memberships[role].includes(name)) || (!allowMissing && names.length !== memberships[role].length)) throw new Error('RUNTIME_DATABASE_MEMBERSHIP_INVALID');
}

export async function verifyMigrationManifest(pool) {
  migrationManifest ??= readMigrations();
  const expected = await migrationManifest;
  const actual = (await pool.query('SELECT migration_name,sha256 FROM public.kavaroutes_schema_migration ORDER BY migration_name')).rows;
  if (actual.length !== expected.length || actual.some((row,i) => row.migration_name !== expected[i].name || row.sha256 !== expected[i].checksum)) throw new Error('RUNTIME_MIGRATION_DRIFT');
}

export function makePool(config) {
  const pool = new Pool({ connectionString: config.databaseUrl, max: 4, connectionTimeoutMillis: 3000,
    statement_timeout: 10000, idle_in_transaction_session_timeout: 10000, application_name: 'kavaroutes-private-synthetic' });
  pool.on('error', () => {}); // Never log raw DB errors or credentials. Readiness actively queries the DB.
  return pool;
}

export async function verifyRuntimeDatabase(pool, role) {
  const result = await pool.query('SELECT current_user AS name,rolsuper,rolbypassrls,rolcreatedb,rolcreaterole,rolinherit FROM pg_roles WHERE rolname=current_user');
  const row = result.rows[0];
  if (!row || row.name !== `kr_cloud_${role}` || row.rolsuper || row.rolbypassrls || row.rolcreatedb || row.rolcreaterole || row.rolinherit) throw new Error('RUNTIME_DATABASE_PRIVILEGE_INVALID');
  await verifyMemberships(pool, role);
  await verifyMigrationManifest(pool);
}

export function makeBoss(pool, initialize = false) {
  const boss = new PgBoss({ schema, db: { executeSql: (text, values) => pool.query(text, values) },
    migrate: initialize, createSchema: initialize, schedule: false, supervise: false, monitorIntervalSeconds: 5,
    persistQueueStats: false, persistWarnings: false });
  boss.on('error', () => {});
  return boss;
}

// One-shot administrator only; neither long-running host can migrate or create roles.
export async function initializeDatabase(adminConfig, passwords) {
  validateConfig(adminConfig);
  if (new URL(adminConfig.databaseUrl).username !== 'kr_cloud_admin') throw new Error('RUNTIME_DATABASE_ROLE_INVALID');
  if (!passwords || Object.keys(passwords).sort().join(',') !== 'kr_cloud_api,kr_cloud_worker' ||
      Object.values(passwords).some(value => typeof value !== 'string' || !/^[A-Za-z0-9_-]{43,}$/.test(value))) throw new Error('RUNTIME_PASSWORD_INVALID');
  const pool = makePool(adminConfig);
  const boss = makeBoss(pool, true);
  try {
    for (const role of ['api','worker']) {
      const existing = (await pool.query('SELECT rolsuper,rolbypassrls,rolcreatedb,rolcreaterole,rolinherit FROM pg_roles WHERE rolname=$1', [`kr_cloud_${role}`])).rows[0];
      if (existing && Object.values(existing).some(Boolean)) throw new Error('RUNTIME_DATABASE_PRIVILEGE_INVALID');
      if (existing) await verifyMemberships(pool, role, true);
    }
    const client = await pool.connect();
    try { await applyMigrations(client); } finally { client.release(); }
    await verifyMigrationManifest(pool);
    await boss.start();
    for (const route of routes) await boss.createQueue(ROUTE_POLICIES[route].queue);
    for (const name of ['kr_cloud_api', 'kr_cloud_worker']) {
      const password = passwords[name];
      if (!/^[A-Za-z0-9_-]{43,}$/.test(password ?? '')) throw new Error('RUNTIME_PASSWORD_INVALID');
      const exists = await pool.query('SELECT 1 FROM pg_roles WHERE rolname=$1', [name]);
      if (!exists.rowCount) await pool.query(`CREATE ROLE ${name} LOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`);
      // Strict base64url above prevents SQL literal injection; never emit this SQL.
      await pool.query(`ALTER ROLE ${name} NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD '${password}'`);
    }
    await pool.query('GRANT kavaroutes_api, kavaroutes_realtime TO kr_cloud_api');
    await pool.query('GRANT SELECT ON public.kavaroutes_schema_migration TO kr_cloud_api,kr_cloud_worker');
    await pool.query('GRANT USAGE ON SCHEMA public TO kr_cloud_api,kr_cloud_worker');
    await pool.query('GRANT kavaroutes_outbox_publisher, kavaroutes_outbox_consumer TO kr_cloud_worker');
    await pool.query('GRANT USAGE ON SCHEMA outbox TO kr_cloud_worker');
    await pool.query('GRANT USAGE ON SCHEMA platform TO kr_cloud_worker');
    await pool.query('GRANT EXECUTE ON FUNCTION platform.current_tenant_id() TO kr_cloud_worker');
    await pool.query('GRANT SELECT ON outbox.consumer_transport_journal TO kr_cloud_worker');
    await pool.query('GRANT USAGE ON SCHEMA intake TO kavaroutes_outbox_consumer');
    await pool.query('GRANT SELECT (tenant_id,id,service_date) ON intake.trip_request TO kavaroutes_outbox_consumer');
    await pool.query(`REVOKE ALL ON SCHEMA ${schema} FROM PUBLIC`);
    await pool.query(`GRANT USAGE ON SCHEMA ${schema} TO kr_cloud_worker, kavaroutes_outbox_publisher`);
    await pool.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${schema} TO kr_cloud_worker, kavaroutes_outbox_publisher`);
    await pool.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA ${schema} TO kr_cloud_worker, kavaroutes_outbox_publisher`);
    await pool.query(`GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA ${schema} TO kr_cloud_worker, kavaroutes_outbox_publisher`);
    await withTenantTransaction(pool, tenantId, 'kavaroutes_api', async client => {
      await client.query("INSERT INTO platform.organization(tenant_id,id,synthetic_name) VALUES ($1,$1,'Synthetic cloud conformance') ON CONFLICT DO NOTHING", [tenantId]);
      await client.query("INSERT INTO intake.rider(tenant_id,id,synthetic_reference) VALUES ($1,$2,'synthetic-cloud-rider') ON CONFLICT DO NOTHING", [tenantId, riderId]);
    });
  } finally { await boss.stop(); await pool.end(); }
}
