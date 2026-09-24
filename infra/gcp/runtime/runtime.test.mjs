import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, writeFile, chmod, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateConfig, classifyFailure, retryDue, readConfig } from './config.mjs';
import { runtimeManifest, validateManifest } from './manifest.mjs';

test('adapter manifest rejects missing, unknown, live and falsely promoted adapters', () => {
  assert.equal(validateManifest().environment, 'private-synthetic');
  for (const mutate of [value => value.adapters.pop(), value => value.adapters.push({ id: 'unknown' }),
    value => { value.adapters.find(item => item.id === 'maps').implementation = 'google'; },
    value => { value.adapters.find(item => item.id === 'storage').decision = 'replace'; },
    value => { value.environment = 'production'; }]) {
    const value = structuredClone(runtimeManifest); mutate(value);
    assert.throws(() => validateManifest(value), /RUNTIME_ADAPTER_MANIFEST_INVALID/);
  }
});

export function config(role, password, port = 58080, dbPort = 55434) {
  return { profile: 'private-synthetic', databaseUrl: `postgresql://kr_cloud_${role}:${password}@127.0.0.1:${dbPort}/kavaroutes_cloud`,
    etagSecret: `synthetic-etag-secret-${randomBytes(32).toString('base64url')}`, cursorSecret: randomBytes(32).toString('base64url'), port };
}
test('configuration is closed, private and synthetic-only', () => {
  const valid = config('api', randomBytes(32).toString('base64url'));
  assert.equal(validateConfig(valid).profile, 'private-synthetic');
  for (const change of [{ profile: 'production' }, { maps: 'google' }, { port: 80 }, { etagSecret: '' },
    { mapsApiKey: 'bad key with spaces' }, { mapsStaticKey: 'bad key with spaces' },
    { databaseUrl: valid.databaseUrl.replace('127.0.0.1', 'example.com') },
    { databaseUrl: `${valid.databaseUrl}?sslmode=disable` }, { databaseUrl: valid.databaseUrl.replace('kr_cloud_api', 'postgres') }]) {
    assert.throws(() => validateConfig({ ...valid, ...change }), /RUNTIME_/);
  }
});
test('secret files reject missing, permissive, malformed, oversized, symlink and wrong-role inputs', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'kr-secret-test-'));
  const path = join(directory, 'secret.json');
  const valid = config('api', randomBytes(32).toString('base64url'));
  try {
    await assert.rejects(() => readConfig(path, 'api'), /RUNTIME_SECRET_FILE_INVALID/);
    await writeFile(path, JSON.stringify(valid), { mode: 0o600 });
    assert.equal((await readConfig(path, 'api')).profile, 'private-synthetic');
    await assert.rejects(() => readConfig(path, 'worker'), /RUNTIME_DATABASE_ROLE_INVALID/);
    await symlink(path, join(directory, 'link.json'));
    await assert.rejects(() => readConfig(join(directory, 'link.json'), 'api'), /RUNTIME_SECRET_FILE_INVALID/);
    await chmod(path, 0o644);
    await assert.rejects(() => readConfig(path, 'api'), /RUNTIME_SECRET_FILE_INVALID/);
    await chmod(path, 0o600);
    for (const content of ['{malformed', 'x'.repeat(8193)]) {
      await writeFile(path, content);
      await assert.rejects(() => readConfig(path, 'api'), /RUNTIME_SECRET_FILE_INVALID/);
    }
    for (const input of [null, true, 1, 'bad', []]) assert.throws(() => validateConfig(input), /RUNTIME_CONFIG_INVALID/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('closed retry classifications and persistent retry bounds', () => {
  assert.equal(classifyFailure({ code: '40001' }), 'DATABASE_CONCURRENCY');
  assert.equal(classifyFailure(new Error('REALTIME_SOURCE_VERSION_GAP:1:2')), 'TRANSIENT_DEPENDENCY');
  assert.equal(classifyFailure(new Error('secret-canary')), 'PERMANENT_VALIDATION');
  const now = Date.now();
  const job = { output: { code: 'TRANSIENT_DEPENDENCY' }, retry_count: 0, created_on: new Date(now - 10000), completed_on: new Date(now - 3000) };
  assert.equal(retryDue(job, now), true);
  assert.equal(retryDue({ ...job, retry_count: 7 }, now), false);
  assert.equal(retryDue({ ...job, output: { code: 'PERMANENT_VALIDATION' } }, now), false);
  assert.equal(retryDue({ ...job, created_on: new Date(now - 86400001) }, now), false);
});
