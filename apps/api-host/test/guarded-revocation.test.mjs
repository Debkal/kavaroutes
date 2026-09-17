// A-009: provider-revocation enforcement through the composed guarded host.
//
// The database is a scripted double because this sandbox has no PostgreSQL
// (Docker is denied); it answers the exact statements the composition issues —
// the session resolution join, the bounded tenant reader and the revocation
// UPDATE — so the real host code, the real session resolver and the real
// revocation sweeper are exercised. The container-backed PostgreSQL lane in the
// hosted workflow remains the authority for the SQL itself.
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { createBrowserCredentials } from '../dist/browser-credentials.js';
import { createGuardedApiHost } from '../dist/guarded-composition.js';

const origin = 'https://app.kavaroutes.com';
const tenantId = '71000000-0000-4000-8000-000000000001';
const principalId = '71000000-0000-4000-8000-000000000012';
const providerSubject = '110000000000000000001';
const guardedSecret = () => randomBytes(32).toString('base64url');

function config(signingKey) {
  return { profile: 'guarded-live', origin, host: '127.0.0.1', port: 58080,
    databaseUrl: 'postgresql://kr_cloud_api:reviewed-password@127.0.0.1:5432/kavaroutes_cloud',
    etagSecret: guardedSecret(), cursorSecret: guardedSecret(), signingKey,
    issuer: 'https://securetoken.google.com/kavaroutes', audience: 'kavaroutes',
    maximumAuthenticationAgeSeconds: 300, trustedProxyHops: 1 };
}

/** Scripted pool: answers the guarded composition's own statements only. */
function scriptedPool(session) {
  const state = { sessionUpdates: [], tenantReads: 0 };
  const revoked = session.revoked === true;
  const sessionRow = () => ({ organization_id: tenantId, user_id: randomUUID(), principal_id: principalId, role: 'DISPATCHER',
    driver_id: null, authorization_generation: 1, expires_at: session.expiresAt, subject: session.subject,
    created_at: session.createdAt, scope_kinds: [], capability_grants: [] });
  const dispatch = async (text, params) => {
    if (/enrolled_tenants/.test(text)) { state.tenantReads += 1; return { rows: [{ tenant_id: tenantId }], rowCount: 1 }; }
    if (/FROM platform\.application_session/.test(text)) return revoked && /revoked_at IS NULL/.test(text)
      ? { rows: [], rowCount: 0 } : { rows: [sessionRow()], rowCount: 1 };
    if (/UPDATE platform\.application_session/.test(text)) {
      state.sessionUpdates.push({ text, params });
      return { rows: [], rowCount: 1 };
    }
    if (/SELECT 1/.test(text)) return { rows: [{ '?column?': 1 }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  };
  const client = { query: dispatch, release: () => {} };
  return { state, async query(text, params) { return dispatch(text, params); }, async connect() { return client; }, end: async () => {} };
}

function hostFor({ signingKey, session, accounts }) {
  return createGuardedApiHost({ config: config(signingKey), activate: async () => {},
    verifyProviderToken: async () => ({ issuer: 'https://securetoken.google.com/kavaroutes', subject: randomUUID(),
      audience: 'kavaroutes', authenticatedAt: new Date().toISOString() }),
    providerAccounts: accounts, pool: scriptedPool(session),
    providerRevocation: { maximumStalenessMilliseconds: 300_000, batchSize: 10, checkDeadlineMilliseconds: 50,
      sweepIntervalMilliseconds: 60_000 } });
}

function sessionFixture(overrides = {}) {
  return { subject: providerSubject, createdAt: new Date(Date.now() - 60_000).toISOString(),
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(), revoked: false, ...overrides };
}

function browserHeaders(signingKey, issued, method = 'GET') {
  const headers = { cookie: issued.cookie.split(';')[0], 'x-forwarded-proto': 'https', 'sec-fetch-site': 'same-origin' };
  if (method === 'GET') return headers;
  return { ...headers, origin, 'x-kr-csrf': issued.csrf };
}

function accountState(state, revokedAt = null) {
  return { checkAccount: async () => state, revokedAt: async () => revokedAt };
}

test('the composed host refuses a session whose provider account is disabled', async () => {
  const signingKey = randomBytes(32);
  const issued = createBrowserCredentials({ origin, signingKey }).issue(tenantId);
  const assembled = await hostFor({ signingKey, session: sessionFixture(), accounts: accountState('ACTIVE') });
  const allowed = await assembled.app.inject({ url: '/v1/me', headers: browserHeaders(signingKey, issued) });
  assert.equal(allowed.statusCode, 200, allowed.body);
  await assembled.close();
  // A second host whose provider reports the account disabled must refuse the
  // same persisted session on the very next request.
  const disabled = await hostFor({ signingKey, session: sessionFixture(), accounts: accountState('DISABLED') });
  const denied = await disabled.app.inject({ url: '/v1/me', headers: browserHeaders(signingKey, issued) });
  assert.equal(denied.statusCode, 401, denied.body);
  assert.equal(denied.json().code, 'AUTHENTICATION_REQUIRED');
  const realtime = await disabled.app.inject({ method: 'POST', url: `/v1/organizations/${tenantId}/realtime-change-queries`,
    headers: browserHeaders(signingKey, issued, 'POST'), payload: {} });
  assert.equal(realtime.statusCode, 401, 'the realtime route is gated by the same session verifier');
  await disabled.close();
});

test('a provider revocation at or after the session authentication refuses that session', async () => {
  const signingKey = randomBytes(32);
  const issued = createBrowserCredentials({ origin, signingKey }).issue(tenantId);
  const created = new Date(Date.now() - 3_600_000);
  const session = sessionFixture({ createdAt: created.toISOString() });
  const after = await hostFor({ signingKey, session, accounts: accountState('ACTIVE', new Date(created.getTime() + 60_000).toISOString()) });
  const revoked = await after.app.inject({ url: '/v1/me', headers: browserHeaders(signingKey, issued) });
  assert.equal(revoked.statusCode, 401, 'a revocation after the session authenticated must win');
  await after.close();
  const before = await hostFor({ signingKey, session, accounts: accountState('ACTIVE', new Date(created.getTime() - 60_000).toISOString()) });
  const surviving = await before.app.inject({ url: '/v1/me', headers: browserHeaders(signingKey, issued) });
  assert.equal(surviving.statusCode, 200, 'a session authenticated after the revocation stays valid');
  await before.close();
});

test('an unverifiable provider fails closed with 503 rather than preserving stale authority', async () => {
  const signingKey = randomBytes(32);
  const issued = createBrowserCredentials({ origin, signingKey }).issue(tenantId);
  const unreachable = { checkAccount: async () => { throw new Error('PROVIDER_UNREACHABLE'); },
    revokedAt: async () => { throw new Error('PROVIDER_UNREACHABLE'); } };
  const assembled = await hostFor({ signingKey, session: sessionFixture(), accounts: unreachable });
  const response = await assembled.app.inject({ url: '/v1/me', headers: browserHeaders(signingKey, issued) });
  assert.equal(response.statusCode, 503, response.body);
  assert.equal(assembled.revocation.status().state, 'DEGRADED');
  await assembled.close();
});

test('the composed sweep revokes the sessions that predate a provider revocation', async () => {
  const signingKey = randomBytes(32);
  const created = new Date(Date.now() - 3_600_000);
  const revokedAt = new Date(created.getTime() + 1_000).toISOString();
  const session = sessionFixture({ createdAt: created.toISOString() });
  const pool = scriptedPool(session);
  const assembled = await createGuardedApiHost({ config: config(signingKey), activate: async () => {},
    verifyProviderToken: async () => ({ issuer: 'https://securetoken.google.com/kavaroutes', subject: randomUUID(),
      audience: 'kavaroutes', authenticatedAt: new Date().toISOString() }),
    providerAccounts: accountState('ACTIVE', revokedAt), pool,
    providerRevocation: { maximumStalenessMilliseconds: 300_000, batchSize: 10, checkDeadlineMilliseconds: 50 } });
  const sweep = await assembled.revocation.runOnce();
  assert.equal(sweep.state, 'CURRENT');
  assert.equal(sweep.listed, 1);
  assert.equal(sweep.revoked, 1);
  assert.equal(pool.state.sessionUpdates.length, 1, 'the sweep revokes through the composed database ports');
  const [update] = pool.state.sessionUpdates;
  assert.equal(update.params[0], tenantId);
  assert.equal(update.params[1], providerSubject, 'the opaque handle resolves to the provider subject');
  assert.equal(update.params[2], revokedAt);
  assert.match(update.text, /date_trunc\('second',created_at\)<=date_trunc\('second',\$3::timestamptz\)/,
    'the revocation comparison is second-truncated on both sides');
  assert.equal(assembled.revocation.status().subjectsWithFreshEvidence, 1);
  await assembled.close();
});

test('a guarded host cannot be composed without provider account ports, and rejected activation composes nothing', async () => {
  const signingKey = randomBytes(32);
  await assert.rejects(() => createGuardedApiHost({ config: config(signingKey), activate: async () => {},
    verifyProviderToken: async () => ({ issuer: 'https://securetoken.google.com/kavaroutes', subject: randomUUID(),
      audience: 'kavaroutes', authenticatedAt: new Date().toISOString() }),
    pool: scriptedPool(sessionFixture()) }), /GUARDED_PROVIDER_ACCOUNTS_REQUIRED/);
  await assert.rejects(() => createGuardedApiHost({ config: config(signingKey),
    activate: async () => { throw new Error('ACTIVATION_DENIED'); },
    verifyProviderToken: async () => ({ issuer: 'https://securetoken.google.com/kavaroutes', subject: randomUUID(),
      audience: 'kavaroutes', authenticatedAt: new Date().toISOString() }),
    providerAccounts: accountState('ACTIVE'), pool: scriptedPool(sessionFixture()) }), /ACTIVATION_DENIED/);
});

test('A-010: the browser session bootstrap obeys the same provider gate as REST', async () => {
  const signingKey = randomBytes(32);
  const issued = createBrowserCredentials({ origin, signingKey }).issue(tenantId);
  const session = sessionFixture();
  const sessionHeaders = { cookie: issued.cookie.split(';')[0], origin, 'x-kr-csrf': issued.csrf,
    'x-forwarded-proto': 'https', 'sec-fetch-site': 'same-origin' };
  const bootstrap = { method: 'POST', url: '/auth/session', headers: { cookie: issued.cookie.split(';')[0],
    origin, 'x-forwarded-proto': 'https', 'sec-fetch-site': 'same-origin' } };

  // Active provider: the bootstrap and the business route agree, and the
  // bootstrap still hands back the CSRF the opaque cookie cannot carry.
  const active = await hostFor({ signingKey, session, accounts: accountState('ACTIVE') });
  const activeBootstrap = await active.app.inject(bootstrap);
  assert.equal(activeBootstrap.statusCode, 200, activeBootstrap.body);
  assert.equal(activeBootstrap.json().csrf, issued.csrf);
  assert.equal((await active.app.inject({ url: '/v1/me', headers: sessionHeaders })).statusCode, 200);
  await active.close();

  // Disabled account: the bootstrap must be refused exactly like `/v1/me`, and
  // the terminal invalidity must clear the session cookie so the browser stops
  // presenting it.
  const disabled = await hostFor({ signingKey, session, accounts: accountState('DISABLED') });
  const disabledBootstrap = await disabled.app.inject(bootstrap);
  assert.equal(disabledBootstrap.statusCode, 401, disabledBootstrap.body);
  assert.match(String(disabledBootstrap.headers['set-cookie']), /Max-Age=0/);
  assert.equal((await disabled.app.inject({ url: '/v1/me', headers: sessionHeaders })).statusCode, 401);
  await disabled.close();

  // Provider revocation at/after the session authentication.
  const created = new Date(Date.now() - 3_600_000);
  const revokedSession = sessionFixture({ createdAt: created.toISOString() });
  const revoked = await hostFor({ signingKey, session: revokedSession,
    accounts: accountState('ACTIVE', new Date(created.getTime() + 60_000).toISOString()) });
  assert.equal((await revoked.app.inject(bootstrap)).statusCode, 401);
  await revoked.close();

  // Provider this host cannot consult: bounded safe failure, cookie preserved
  // so the user can retry once the provider answers.
  const unreachable = await hostFor({ signingKey, session,
    accounts: { checkAccount: async () => { throw new Error('PROVIDER_UNREACHABLE'); },
      revokedAt: async () => { throw new Error('PROVIDER_UNREACHABLE'); } } });
  const unavailable = await unreachable.app.inject(bootstrap);
  assert.equal(unavailable.statusCode, 503, unavailable.body);
  assert.deepEqual(unavailable.json(), { error: 'SESSION_UNAVAILABLE' });
  assert.equal(unavailable.headers['set-cookie'], undefined);
  assert.equal((await unreachable.app.inject({ url: '/v1/me', headers: sessionHeaders })).statusCode, 503);
  // Logout during the same outage is the one explicit exception: the user asked
  // to end the session, so the durable row is revoked and the cookie cleared.
  const logoutDuringOutage = await unreachable.app.inject({ method: 'POST', url: '/auth/logout',
    headers: { ...sessionHeaders } });
  assert.equal(logoutDuringOutage.statusCode, 204, logoutDuringOutage.body);
  assert.match(String(logoutDuringOutage.headers['set-cookie']), /Max-Age=0/);
  await unreachable.close();

  // Already revoked locally: the row is gone, so bootstrap is refused and the
  // cookie is cleared without any provider call.
  const revokedLocally = await hostFor({ signingKey, session: sessionFixture({ revoked: true }), accounts: accountState('ACTIVE') });
  const gone = await revokedLocally.app.inject(bootstrap);
  assert.equal(gone.statusCode, 401, gone.body);
  assert.match(String(gone.headers['set-cookie']), /Max-Age=0/);
  await revokedLocally.close();
});
