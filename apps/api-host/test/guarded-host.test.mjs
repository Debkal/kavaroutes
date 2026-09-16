import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { createWp007PostgresApplication } from '@kavaroutes/api-contracts';
import { createGuardedApiHost } from '../dist/guarded-composition.js';

const guardedSecret = () => randomBytes(32).toString('base64url');

const config = overrides => ({ profile: 'guarded-live', origin: 'https://app.kavaroutes.com', host: '127.0.0.1', port: 58080,
  databaseUrl: 'postgresql://kr_cloud_api:reviewed-password@127.0.0.1:5432/kavaroutes_cloud',
  etagSecret: guardedSecret(), cursorSecret: guardedSecret(), signingKey: randomBytes(32),
  issuer: 'https://securetoken.google.com/kavaroutes', audience: 'kavaroutes',
  maximumAuthenticationAgeSeconds: 300, trustedProxyHops: 1, ...overrides });

function stubPool() {
  const state = { ready: true, queries: 0 };
  const client = { query: async () => ({ rows: [], rowCount: 0 }), release: () => {} };
  return { state, async query() { state.queries += 1; if (!state.ready) throw new Error('DATABASE_UNAVAILABLE'); return { rows: [{ '?column?': 1 }], rowCount: 1 }; },
    async connect() { return client; }, end: async () => {} };
}

const host = (pool, overrides = {}) => createGuardedApiHost({ config: config(overrides.config), activate: overrides.activate ?? (async () => {}),
  verifyProviderToken: async () => ({ issuer: 'https://securetoken.google.com/kavaroutes', subject: randomUUID(),
    audience: 'kavaroutes', authenticatedAt: new Date().toISOString() }), pool,
  // Provider account state is a required port for this profile: a host that
  // cannot answer "disabled?" and "authentication revoked?" must not compose.
  providerAccounts: overrides.providerAccounts ?? { checkAccount: async () => 'ACTIVE', revokedAt: async () => null },
  ...overrides.options });

test('the reviewed guarded profile refuses a test-marked application key', () => {
  const pool = stubPool();
  assert.throws(() => createWp007PostgresApplication(pool, { etagSecret: `synthetic-etag-secret-${'a'.repeat(32)}`, secretProfile: 'reviewed-guarded' }),
    /GUARDED_ETAG_SECRET_REQUIRED/);
  // The default profile is unchanged: it still requires the synthetic marker.
  assert.throws(() => createWp007PostgresApplication(pool, { etagSecret: guardedSecret() }), /TEST_ETAG_SECRET_REQUIRED/);
  assert.throws(() => createWp007PostgresApplication(pool, { etagSecret: `synthetic-etag-secret-${'a'.repeat(32)}`, secretProfile: 'guarded' }),
    /TEST_ETAG_SECRET_REQUIRED/);
});

test('a valid guarded configuration constructs the host, and rejected activation constructs nothing', async () => {
  const pool = stubPool();
  let activated = false;
  const assembled = await host(pool, { activate: async () => { activated = true; } });
  assert.equal(activated, true, 'activation is awaited before the host exists');
  assert.equal(typeof assembled.app.inject, 'function');
  assert.equal(assembled.origin, 'https://app.kavaroutes.com');
  await assembled.close();
  await assert.rejects(() => host(stubPool(), { activate: async () => { throw new Error('ACTIVATION_DENIED'); } }), /ACTIVATION_DENIED/);
});

test('readiness is unauthenticated and reports only database reachability', async () => {
  const pool = stubPool();
  const assembled = await host(pool);
  // `trustedProxyHops: 1` means a trusted TLS edge in front of the loopback
  // listener: injections must present the forwarded scheme that edge sets.
  const forwarded = { 'x-forwarded-proto': 'https' };
  const ready = await assembled.app.inject({ method: 'GET', url: '/health/ready', headers: forwarded });
  assert.equal(ready.statusCode, 200, ready.body);
  assert.deepEqual(ready.json(), { status: 'ready', profile: 'guarded-live' });
  pool.state.ready = false;
  const unavailable = await assembled.app.inject({ method: 'GET', url: '/health/ready', headers: forwarded });
  assert.equal(unavailable.statusCode, 503, unavailable.body);
  assert.deepEqual(unavailable.json(), { status: 'unavailable' });
  await assembled.close();
});

test('the assembled host denies non-loopback peers, unreviewed paths and anonymous traffic', async () => {
  const pool = stubPool();
  const assembled = await host(pool);
  const organizationId = randomUUID();
  const snapshotUrl = `/v1/organizations/${organizationId}/runtime-dispatch-snapshot?serviceDate=2026-09-16`;
  const edge = await assembled.app.inject({ method: 'GET', url: snapshotUrl, remoteAddress: '10.0.0.5' });
  assert.equal(edge.statusCode, 403, edge.body);
  assert.deepEqual(edge.json(), { code: 'GUARDED_EDGE_REQUIRED' });
  const noForwardedProto = await assembled.app.inject({ method: 'GET', url: snapshotUrl });
  assert.equal(noForwardedProto.statusCode, 403, noForwardedProto.body);
  const forwarded = { 'x-forwarded-proto': 'https' };
  // The edge guard and the promoted-path allowlist must cover the wp007 business
  // surface, not only the routes this composition registers itself. An outer
  // hook does not reach routes the API lifecycle plugin registered, so the
  // business route below is refused for a non-loopback peer and an unreviewed
  // path — registered or not — is refused before any handler runs.
  const reviewedBusiness = `/v1/organizations/${organizationId}/trips`;
  const businessOffsite = await assembled.app.inject({ method: 'GET', url: reviewedBusiness, remoteAddress: '10.0.0.5', headers: forwarded });
  assert.equal(businessOffsite.statusCode, 403, businessOffsite.body);
  assert.deepEqual(businessOffsite.json(), { code: 'GUARDED_EDGE_REQUIRED' });
  const businessAnonymous = await assembled.app.inject({ method: 'GET', url: reviewedBusiness, headers: forwarded });
  assert.equal(businessAnonymous.statusCode, 401, businessAnonymous.body);
  for (const url of [`/v1/organizations/${organizationId}/driver/manifest`, `/v1/organizations/${organizationId}/unknown-path`,
    '/v1/not-promoted']) {
    const offsite = await assembled.app.inject({ method: 'GET', url, remoteAddress: '10.0.0.5', headers: forwarded });
    assert.equal(offsite.statusCode, 403, `${url} offsite → ${offsite.statusCode} ${offsite.body}`);
    assert.deepEqual(offsite.json(), { code: 'GUARDED_EDGE_REQUIRED' });
    const unreviewed = await assembled.app.inject({ method: 'GET', url, headers: forwarded });
    assert.equal(unreviewed.statusCode, 503, `${url} → ${unreviewed.statusCode} ${unreviewed.body}`);
    assert.deepEqual(unreviewed.json(), { code: 'RUNTIME_PATH_NOT_PROMOTED' });
  }
  // Anonymous, and a cookie whose session does not resolve, are both refused on
  // the REST routes and on the realtime routes registered in the authenticated
  // scope. No Authorization header is ever interpreted in this profile.
  for (const url of [snapshotUrl, `/v1/organizations/${organizationId}/realtime-change-queries`, `/v1/me`]) {
    const method = url === '/v1/me' ? 'GET' : 'POST';
    // A JSON POST has to declare its media type; that check runs after the
    // guards and before authentication, exactly as in the wp007 lifecycle.
    const headers = method === 'POST' ? { ...forwarded, 'content-type': 'application/json' } : forwarded;
    const anonymous = await assembled.app.inject({ method, url, headers });
    assert.equal([401, 404].includes(anonymous.statusCode), true, `${url} → ${anonymous.statusCode} ${anonymous.body}`);
    const bearerOnly = await assembled.app.inject({ method, url, headers: { ...headers, authorization: 'Synthetic principal_dispatcher' } });
    assert.notEqual(bearerOnly.statusCode, 200, 'a synthetic principal is never accepted here');
    const unknownCookie = await assembled.app.inject({ method, url,
      headers: { ...headers, cookie: `__Host-kr-session=${randomUUID()}.${randomBytes(32).toString('base64url')}` } });
    assert.equal([401, 404].includes(unknownCookie.statusCode), true, `${url} cookie → ${unknownCookie.statusCode} ${unknownCookie.body}`);
  }
  await assembled.close();
});
