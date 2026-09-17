/**
 * Guarded-profile hardening that the CQ-003 acceptance list asks for and that no
 * existing test covered: the reviewed application-level connection/frame limits,
 * the reviewed redacting logger, and the safe per-request telemetry trail.
 *
 * Added 2026-09-16 because both behaviours changed in this session
 * (`packages/api-contracts/src/api.ts` gained opt-in `serverLimits`/`logger`,
 * `guarded-composition.ts` passes them). The existing guarded tests are untouched.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { createGuardedApiHost } from '../dist/guarded-composition.js';
import { API_NETWORK_LIMITS } from '../dist/network-security.js';
import { safePinoOptions } from '../dist/logging.js';

const guardedSecret = () => randomBytes(32).toString('base64url');

const config = () => ({ profile: 'guarded-live', origin: 'https://app.kavaroutes.com', host: '127.0.0.1', port: 58080,
  databaseUrl: 'postgresql://kr_cloud_api:reviewed-password@127.0.0.1:5432/kavaroutes_cloud',
  etagSecret: guardedSecret(), cursorSecret: guardedSecret(), signingKey: randomBytes(32),
  issuer: 'https://securetoken.google.com/kavaroutes', audience: 'kavaroutes',
  maximumAuthenticationAgeSeconds: 300, trustedProxyHops: 1 });

function stubPool() {
  const client = { query: async () => ({ rows: [], rowCount: 0 }), release: () => {} };
  return { async query() { return { rows: [{ '?column?': 1 }], rowCount: 1 }; }, async connect() { return client; }, end: async () => {} };
}

const host = async () => createGuardedApiHost({ config: config(), activate: async () => {}, pool: stubPool(),
  verifyProviderToken: async () => ({ issuer: 'https://securetoken.google.com/kavaroutes', subject: randomUUID(),
    audience: 'kavaroutes', authenticatedAt: new Date().toISOString() }),
  providerAccounts: { checkAccount: async () => 'ACTIVE', revokedAt: async () => null } });

test('the guarded host carries the reviewed application connection and frame limits', async () => {
  const assembled = await host();
  const limits = assembled.app.initialConfig;
  assert.equal(limits.connectionTimeout, API_NETWORK_LIMITS.connectionTimeoutMs);
  assert.equal(limits.requestTimeout, API_NETWORK_LIMITS.requestTimeoutMs);
  assert.equal(limits.handlerTimeout, API_NETWORK_LIMITS.handlerTimeoutMs);
  assert.equal(limits.keepAliveTimeout, API_NETWORK_LIMITS.keepAliveTimeoutMs);
  assert.equal(limits.maxRequestsPerSocket, API_NETWORK_LIMITS.maxRequestsPerSocket);
  assert.equal(assembled.app.server.headersTimeout, API_NETWORK_LIMITS.headersTimeoutMs);
  await assembled.close();
});

test('the guarded host logs through the reviewed redacting logger, not silently', async () => {
  // Fastify's `getSecuredInitialConfig` validates the options and drops `logger`
  // (and `redact`) from `initialConfig`, so the configured logger object cannot be
  // read back from the instance. The visible evidence is what the logger emits,
  // which is also the only thing that matters for leakage: capture the guarded
  // host's own stdout, write a record that carries every reviewed secret shape,
  // and assert the redaction actually fired.
  for (const path of ['req.headers.cookie', 'req.headers.authorization', 'url', 'coordinates', 'body'])
    assert.ok(safePinoOptions.redact.paths.includes(path), `the reviewed redaction list lost ${path}`);
  assert.equal(safePinoOptions.redact.censor, '[REDACTED]');
  const unsafeSerializer = JSON.stringify(safePinoOptions.serializers.req({ id: 'req-1', method: 'GET', headers: { cookie: 'serializer-canary' }, url: '/x?y=serializer-canary' }));
  assert.doesNotMatch(unsafeSerializer, /serializer-canary/, 'the request serializer must not emit cookies or URLs');
  const captured = [];
  const originalWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk, ...rest) => { captured.push(String(chunk)); return originalWrite(chunk, ...rest); };
  let assembled;
  try {
    assembled = await host();
    assert.equal(assembled.app.log.level, 'info', 'a disabled logger would make this "silent"');
    assembled.app.log.info({ url: '/v1/me?probe=url-canary', coordinates: [37.7, -122.4], body: { token: 'body-canary' },
      req: { headers: { cookie: 'header-canary', authorization: 'header-canary' } } }, 'guarded-redaction-probe');
  } finally {
    process.stdout.write = originalWrite;
    await assembled?.close();
  }
  const emitted = captured.join('');
  assert.ok(emitted.includes('guarded-redaction-probe'), 'the guarded host emitted no log line at all');
  assert.ok(emitted.includes('[REDACTED]'), 'the guarded host emitted a record without applying the reviewed censor');
  for (const canary of ['url-canary', 'body-canary', 'header-canary'])
    assert.equal(emitted.includes(canary), false, `the guarded logger emitted ${canary}`);
});

test('a guarded response writes one safe telemetry event and no request detail', async () => {
  const assembled = await host();
  const events = [];
  const original = assembled.app.log.info.bind(assembled.app.log);
  assembled.app.log.info = (...args) => { events.push(args); return original(...args); };
  const sessionCanary = `${randomUUID()}.${guardedSecret()}`;
  const forwarded = { 'x-forwarded-proto': 'https', cookie: `__Host-kr-session=${sessionCanary}`, authorization: 'Bearer bearer-canary' };
  const response = await assembled.app.inject({ method: 'GET', url: '/v1/me', headers: forwarded });
  assert.ok([401, 404].includes(response.statusCode), `unexpected ${response.statusCode}`);
  assert.ok(events.length >= 1, 'the telemetry sink did not reach the logger');
  const [first] = events;
  const event = first[0];
  assert.deepEqual(Object.keys(event).sort(), ['latencyBucket', 'operationId', 'resultCode', 'routeTemplate', 'statusCode']);
  assert.equal(typeof event.operationId, 'string');
  assert.equal(typeof event.latencyBucket, 'string');
  assert.equal(event.statusCode, response.statusCode);
  // The route *template* is deliberate safe evidence (a template, never a raw URL),
  // so the leak check must canary the actual secrets rather than forbid the path.
  assert.equal(event.routeTemplate, '/v1/me');
  assert.equal(event.routeTemplate.includes('?'), false);
  const serialized = JSON.stringify(events);
  for (const forbidden of [sessionCanary, 'bearer-canary', '__Host-kr-session', 'authorization', 'cookie', 'x-forwarded-proto'])
    assert.equal(serialized.includes(forbidden), false, `telemetry leaked ${forbidden}`);
  await assembled.close();
});

// CQ-003 item 3 asks for no-store responses and for unsupported paths to fail
// visibly. Both are properties of every guarded response path, including the two
// the composed host refuses before any business handler runs, so they are checked
// together through the assembled host rather than per route.
test('every guarded response is no-store and refusals stay visible and generic', async () => {
  const assembled = await host();
  const forwarded = { 'x-forwarded-proto': 'https' };
  const cases = [
    ['an authenticated business route', { url: '/v1/me', headers: forwarded }],
    ['a path outside the reviewed allowlist', { url: '/v1/definitely-not-reviewed', headers: forwarded }],
    ['a request that did not arrive over the trusted edge', { url: '/v1/me', headers: {} }],
    ['the unauthenticated readiness probe', { url: '/health/ready', headers: forwarded }]
  ];
  for (const [label, request] of cases) {
    const response = await assembled.app.inject(request);
    assert.equal(response.headers['cache-control'], 'no-store', `${label} must not be cacheable`);
    assert.equal(response.headers.pragma, 'no-cache', `${label} must carry the legacy pragma`);
    assert.doesNotMatch(response.body ?? '', /GUARDED_DB|password|postgresql:\/\//, `${label} leaked configuration detail`);
  }
  const unreviewed = await assembled.app.inject({ url: '/v1/definitely-not-reviewed', headers: forwarded });
  assert.equal(unreviewed.statusCode, 503, 'an unreviewed path fails visibly rather than 404-ing silently');
  assert.deepEqual(unreviewed.json(), { code: 'RUNTIME_PATH_NOT_PROMOTED' });
  const offEdge = await assembled.app.inject({ url: '/v1/me', headers: {} });
  assert.equal(offEdge.statusCode, 403);
  assert.deepEqual(offEdge.json(), { code: 'GUARDED_EDGE_REQUIRED' });
  await assembled.close();
});
