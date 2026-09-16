import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes } from 'node:crypto';
import { validateGuardedConfig } from '../dist/guarded-config.js';

const base = overrides => ({ profile: 'guarded-live', origin: 'https://app.kavaroutes.com', host: '127.0.0.1', port: 58080,
  databaseUrl: 'postgresql://kr_cloud_api:real-password@127.0.0.1:5432/kavaroutes_cloud',
  etagSecret: randomBytes(32).toString('base64url'), cursorSecret: randomBytes(32).toString('base64url'),
  signingKey: randomBytes(32), issuer: 'https://securetoken.google.com/kavaroutes', audience: 'kavaroutes',
  maximumAuthenticationAgeSeconds: 300, trustedProxyHops: 1, ...overrides });

test('the reviewed guarded profile is accepted and frozen', () => {
  const config = validateGuardedConfig(base({}));
  assert.equal(config.profile, 'guarded-live');
  assert.equal(config.trustedProxyHops, 1);
  assert.ok(Object.isFrozen(config));
});

test('the guarded profile refuses synthetic marks, loose origins, non-loopback listeners and unknown keys', () => {
  const rejected = [
    ['GUARDED_CONFIG_KEYS_INVALID', base({ extra: true })],
    ['GUARDED_PROFILE_INVALID', base({ profile: 'private-synthetic' })],
    ['GUARDED_ORIGIN_INVALID', base({ origin: 'https://app.kavaroutes.com/' })],
    ['GUARDED_ORIGIN_INVALID', base({ origin: 'http://app.kavaroutes.com' })],
    ['GUARDED_ORIGIN_INVALID', base({ origin: 'https://*.kavaroutes.com' })],
    ['GUARDED_LISTENER_INVALID', base({ host: '0.0.0.0' })],
    ['GUARDED_LISTENER_INVALID', base({ port: 80 })],
    ['GUARDED_DATABASE_INVALID', base({ databaseUrl: 'postgresql://kr_cloud_admin:pw@127.0.0.1:5432/kavaroutes_cloud' })],
    ['GUARDED_SECRET_INVALID', base({ etagSecret: `synthetic-${'a'.repeat(40)}` })],
    ['GUARDED_SECRET_INVALID', base({ cursorSecret: 'too-short' })],
    ['GUARDED_SIGNING_KEY_INVALID', base({ signingKey: randomBytes(16) })],
    ['GUARDED_ISSUER_INVALID', base({ issuer: 'http://securetoken.google.com/kavaroutes' })],
    ['GUARDED_AUDIENCE_INVALID', base({ audience: '*' })],
    ['GUARDED_ISSUER_AUDIENCE_MISMATCH', base({ audience: 'other-project' })],
    ['GUARDED_AUTH_AGE_INVALID', base({ maximumAuthenticationAgeSeconds: 0 })],
    ['GUARDED_PROXY_HOPS_INVALID', base({ trustedProxyHops: 2 })],
  ];
  for (const [code, input] of rejected) assert.throws(() => validateGuardedConfig(input), new RegExp(code), JSON.stringify(input.origin ?? input));
  assert.throws(() => validateGuardedConfig(null), /GUARDED_CONFIG_INVALID/);
});
