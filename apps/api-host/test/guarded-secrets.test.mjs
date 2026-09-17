/**
 * CQ-003 item 3 asks the guarded profile to validate "protected key persistence".
 * This is the loader half of that requirement: the signing key and the rest of the
 * guarded configuration must come from a file only their owner can read, and every
 * weaker arrangement must be refused before any host is constructed.
 *
 * Added 2026-09-17; no existing test was changed.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, chmod, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { decodeSigningKey, loadGuardedConfig, readProtectedSecretJson } from '../dist/guarded-secrets.js';

const validConfig = (overrides = {}) => ({ profile: 'guarded-live', origin: 'https://app.kavaroutes.com',
  host: '127.0.0.1', port: 58080,
  databaseUrl: `postgresql://kr_cloud_api:${randomBytes(18).toString('base64url')}@127.0.0.1:5432/kavaroutes_cloud`,
  etagSecret: randomBytes(32).toString('base64url'), cursorSecret: randomBytes(32).toString('base64url'),
  signingKey: randomBytes(48).toString('base64'),
  issuer: 'https://securetoken.google.com/kavaroutes', audience: 'kavaroutes',
  maximumAuthenticationAgeSeconds: 300, trustedProxyHops: 1, ...overrides });

async function writeSecret(contents, mode = 0o600) {
  const directory = await mkdtemp(join(tmpdir(), 'kr-guarded-secrets-'));
  const path = join(directory, 'guarded-config.json');
  await writeFile(path, typeof contents === 'string' ? contents : JSON.stringify(contents), { mode });
  await chmod(path, mode);
  return path;
}

test('a 0600 configuration file loads and validates, with the key decoded to bytes', async () => {
  const config = validConfig();
  const loaded = await loadGuardedConfig(await writeSecret(config));
  assert.equal(loaded.origin, 'https://app.kavaroutes.com');
  assert.equal(loaded.trustedProxyHops, 1);
  assert.ok(Buffer.isBuffer(loaded.signingKey), 'the signing key must be bytes, never the base64 text');
  assert.equal(loaded.signingKey.toString('base64'), config.signingKey);
  assert.ok(Object.isFrozen(loaded), 'a validated configuration must not be mutable afterwards');
});

test('anything less protected than owner-only read is refused', async () => {
  for (const mode of [0o644, 0o640, 0o604, 0o666]) {
    const path = await writeSecret(validConfig(), mode);
    await assert.rejects(() => readProtectedSecretJson(path), /GUARDED_SECRET_FILE_INVALID/, `mode ${mode.toString(8)}`);
  }
  await assert.rejects(() => readProtectedSecretJson('/nonexistent/guarded-config.json'), /GUARDED_SECRET_FILE_INVALID/);
});

test('a symlink is not followed and an oversized file is refused', async () => {
  const real = await writeSecret(validConfig());
  const directory = await mkdtemp(join(tmpdir(), 'kr-guarded-link-'));
  const link = join(directory, 'guarded-config.json');
  await symlink(real, link);
  await assert.rejects(() => readProtectedSecretJson(link), /GUARDED_SECRET_FILE_INVALID/, 'O_NOFOLLOW must refuse the link');
  const oversized = await writeSecret(' '.repeat(9000));
  await assert.rejects(() => readProtectedSecretJson(oversized), /GUARDED_SECRET_FILE_INVALID/);
});

test('the signing key must be bounded base64 that decodes to 32-128 bytes', () => {
  const key = randomBytes(48).toString('base64');
  assert.equal(decodeSigningKey(key).length, 48);
  const cases = {
    'too short': randomBytes(16).toString('base64'),
    'too long': randomBytes(129).toString('base64'),
    'not base64': 'not base64 at all!!',
    'wrong length for base64': key.slice(0, key.length - 1),
    'a number': 42,
    'a buffer': randomBytes(48)
  };
  for (const [label, value] of Object.entries(cases)) {
    assert.throws(() => decodeSigningKey(value), /GUARDED_SIGNING_KEY_INVALID/, label);
  }
});

test('the file cannot smuggle in extra configuration or a synthetic secret', async () => {
  const cases = [
    [validConfig({ extra: 'value' }), /GUARDED_CONFIG_KEYS_INVALID/],
    [validConfig({ etagSecret: `synthetic-etag-secret-${'a'.repeat(40)}` }), /GUARDED_SECRET_INVALID/],
    [validConfig({ origin: 'http://app.kavaroutes.com' }), /GUARDED_ORIGIN_INVALID/],
    ['[]', /GUARDED_CONFIG_INVALID/],
    ['{ not json', /GUARDED_SECRET_FILE_INVALID/]
  ];
  for (const [contents, expected] of cases) {
    const path = await writeSecret(contents);
    await assert.rejects(() => loadGuardedConfig(path), expected);
  }
});
