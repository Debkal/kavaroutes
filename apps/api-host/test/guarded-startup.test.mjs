/**
 * The `guarded-live` launcher: until 2026-09-17 (UTC) nothing outside the tests
 * constructed `createGuardedApiHost`, so the composed host could not be started at
 * all. This file covers the launcher's ordering and its fail-closed paths — the
 * reviewed activation marker, the protected configuration file, and cleanup when a
 * later step fails. No provider, socket or database is touched (the pool is a stub).
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { GUARDED_ACTIVATION_MARKER, startGuardedHost } from '../dist/guarded-startup.js';

const validConfig = (overrides = {}) => ({ profile: 'guarded-live', origin: 'https://app.kavaroutes.com',
  host: '127.0.0.1', port: 58080,
  databaseUrl: `postgresql://kr_cloud_api:${randomBytes(18).toString('base64url')}@127.0.0.1:5432/kavaroutes_cloud`,
  etagSecret: randomBytes(32).toString('base64url'), cursorSecret: randomBytes(32).toString('base64url'),
  signingKey: randomBytes(48).toString('base64'),
  issuer: 'https://securetoken.google.com/kavaroutes', audience: 'kavaroutes',
  maximumAuthenticationAgeSeconds: 300, trustedProxyHops: 1, ...overrides });

async function writeSecret(contents, mode = 0o600) {
  const directory = await mkdtemp(join(tmpdir(), 'kr-guarded-startup-'));
  const path = join(directory, 'guarded-config.json');
  await writeFile(path, typeof contents === 'string' ? contents : JSON.stringify(contents), { mode });
  await chmod(path, mode);
  return path;
}

function stubPool() {
  const client = { query: async () => ({ rows: [], rowCount: 0 }), release: () => {} };
  return { async query() { return { rows: [{ '?column?': 1 }], rowCount: 1 }; }, async connect() { return client; }, end: async () => {} };
}

function harness(overrides = {}) {
  const calls = { activate: 0, openIdentity: 0, createPool: 0, closedIdentity: 0, endedPool: 0, databaseUrl: null };
  const pool = stubPool();
  return { calls, pool, options: {
    configPath: '/nonexistent/guarded-config.json',
    activation: GUARDED_ACTIVATION_MARKER,
    async activate() { calls.activate += 1; },
    async openIdentity() { calls.openIdentity += 1; return {
      verifyToken: async () => ({ issuer: 'https://securetoken.google.com/kavaroutes', subject: randomUUID(),
        audience: 'kavaroutes', authenticatedAt: new Date().toISOString() }),
      lookupAccount: async () => ({ disabled: false, revokedAt: null }),
      async close() { calls.closedIdentity += 1; } }; },
    createPool(databaseUrl) { calls.createPool += 1; calls.databaseUrl = databaseUrl; return pool; },
    ...overrides } };
}

test('the reviewed activation marker is required before anything is opened', async () => {
  const { calls, options } = harness({ activation: 'guarded-live' });
  await assert.rejects(() => startGuardedHost(options), /GUARDED_ACTIVATION_REQUIRED/);
  assert.deepEqual(calls, { activate: 0, openIdentity: 0, createPool: 0, closedIdentity: 0, endedPool: 0, databaseUrl: null });
});

test('a configuration file weaker than owner-only read refuses, and activation is not run', async () => {
  const { calls, options } = harness({ configPath: await writeSecret(validConfig(), 0o644) });
  await assert.rejects(() => startGuardedHost(options), /GUARDED_SECRET_FILE_INVALID/);
  assert.equal(calls.activate, 0);
  assert.equal(calls.openIdentity, 0);
});

test('the launcher composes the guarded host, then releases host, provider and pool on shutdown', async () => {
  const config = validConfig();
  const { calls, options } = harness({ configPath: await writeSecret(config) });
  const host = await startGuardedHost(options);
  assert.equal(host.origin, 'https://app.kavaroutes.com');
  assert.equal(host.config.profile, 'guarded-live');
  assert.equal(typeof host.app.ready, 'function', 'a composed Fastify instance is returned');
  assert.equal(calls.activate, 1);
  assert.equal(calls.openIdentity, 1);
  assert.equal(calls.createPool, 1);
  assert.equal(calls.databaseUrl, config.databaseUrl, 'the pool is built from the protected configuration, not from the environment');
  await host.shutdown();
  assert.equal(calls.closedIdentity, 1, 'shutdown closes the provider session');
});

test('a failing pool leaves no provider session open behind it', async () => {
  const { calls, options } = harness({ configPath: await writeSecret(validConfig()),
    createPool() { calls.createPool += 1; throw new Error('POOL_UNAVAILABLE'); } });
  await assert.rejects(() => startGuardedHost(options), /POOL_UNAVAILABLE/);
  assert.equal(calls.closedIdentity, 1);
});

test('a failing activation hook opens neither the provider nor the pool', async () => {
  const { calls, options } = harness({ configPath: await writeSecret(validConfig()),
    async activate() { calls.activate += 1; throw new Error('ACTIVATION_DENIED'); } });
  await assert.rejects(() => startGuardedHost(options), /ACTIVATION_DENIED/);
  assert.equal(calls.openIdentity, 0);
  assert.equal(calls.createPool, 0);
});
