import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { initializeDatabase, makePool, verifyRuntimeDatabase } from './database.mjs';

export async function checkDatabaseGuards(admin, passwords, configFor, control) {
  await assert.rejects(() => initializeDatabase(admin, { ...passwords, kr_cloud_worker: 'short' }), /RUNTIME_PASSWORD_INVALID/);
  const api = makePool(configFor('api', passwords.kr_cloud_api));
  try {
    await verifyRuntimeDatabase(api, 'api');
    await control.query('GRANT pg_read_all_data TO kr_cloud_api');
    await assert.rejects(() => verifyRuntimeDatabase(api, 'api'), /RUNTIME_DATABASE_MEMBERSHIP_INVALID/);
    await assert.rejects(() => initializeDatabase(admin, passwords), /RUNTIME_DATABASE_MEMBERSHIP_INVALID/);
    await control.query('REVOKE pg_read_all_data FROM kr_cloud_api');
    await control.query('ALTER ROLE kr_cloud_api CREATEDB');
    await assert.rejects(() => verifyRuntimeDatabase(api, 'api'), /RUNTIME_DATABASE_PRIVILEGE_INVALID/);
    await assert.rejects(() => initializeDatabase(admin, passwords), /RUNTIME_DATABASE_PRIVILEGE_INVALID/);
    await control.query('ALTER ROLE kr_cloud_api NOCREATEDB');
    const first = (await control.query('SELECT migration_name,sha256 FROM public.kavaroutes_schema_migration ORDER BY migration_name LIMIT 1')).rows[0];
    await control.query('UPDATE public.kavaroutes_schema_migration SET sha256=$1 WHERE migration_name=$2', ['0'.repeat(64),first.migration_name]);
    await assert.rejects(() => verifyRuntimeDatabase(api, 'api'), /RUNTIME_MIGRATION_DRIFT/);
    await assert.rejects(() => initializeDatabase(admin, passwords), /MIGRATION_CHECKSUM_MISMATCH/);
    await control.query('UPDATE public.kavaroutes_schema_migration SET sha256=$1 WHERE migration_name=$2', [first.sha256,first.migration_name]);
    await control.query("INSERT INTO public.kavaroutes_schema_migration(migration_name,sha256) VALUES ('9999_unexpected.sql',$1)", ['0'.repeat(64)]);
    await assert.rejects(() => verifyRuntimeDatabase(api, 'api'), /RUNTIME_MIGRATION_DRIFT/);
    await assert.rejects(() => initializeDatabase(admin, passwords), /RUNTIME_MIGRATION_DRIFT/);
    await control.query("DELETE FROM public.kavaroutes_schema_migration WHERE migration_name='9999_unexpected.sql'");
    await verifyRuntimeDatabase(api, 'api');
  } finally { await api.end(); }
  // Rotate both credentials. Existing sessions are not revoked by password changes;
  // prove old credentials fail on fresh connections and restart with new ones.
  const old = { ...passwords };
  for (const key of Object.keys(passwords)) passwords[key] = randomBytes(32).toString('base64url');
  await initializeDatabase(admin, passwords);
  for (const role of ['api','worker']) {
    const rejected = makePool(configFor(role, old[`kr_cloud_${role}`]));
    try { await assert.rejects(() => rejected.query('SELECT 1'), error => error.code === '28P01'); }
    finally { await rejected.end(); }
    const accepted = makePool(configFor(role, passwords[`kr_cloud_${role}`]));
    try { await verifyRuntimeDatabase(accepted, role); } finally { await accepted.end(); }
  }
}
