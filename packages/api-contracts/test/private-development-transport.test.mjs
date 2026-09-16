import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPrivateDevelopmentTransport } from '../dist/private-development-transport.js';

const response = (status = 200, body = { version: 1 }) => ({ status,
  headers: { get: name => name === 'etag' ? '"opaque-server-tag"' : null }, json: async () => body });
const decode = body => { assert.equal(typeof body.version, 'number'); return body; };
const make = (fetch, extra = {}) => createPrivateDevelopmentTransport({ baseUrl: 'http://127.0.0.1:58080', persona: 'driver', fetch, ...extra });

test('Pony transport selects four exact company-scoped identities and no arbitrary principal', async () => {
  for (const company of ['ponytransport', 'ponybigbusiness']) for (const persona of ['driver', 'dispatcher']) {
    const client = make(async (_url, init) => {
      assert.equal(init.headers.authorization, `Synthetic principal_${company}_${persona}`);
      return response();
    }, { ponyCompany: company, persona });
    await client.request('/v1/me', decode);
  }
  for (const options of [{ ponyCompany: 'unknown' }, { ponyCompany: 'ponytransport', persona: 'policy_override' }, { ponyCompany: 'ponybigbusiness', persona: 'facility' }]) {
    assert.throws(() => make(async () => assert.fail('must not fetch'), options), /PONY_PERSONA_NOT_FOUND/);
  }
});

test('rejects nonprivate endpoints and credential-bearing URLs', () => {
  for (const baseUrl of ['https://example.com', 'http://localhost:58080', 'http://127.0.0.1:58080/v1', 'http://u:p@127.0.0.1:58080', 'http://127.0.0.1:58080?token=x']) {
    assert.throws(() => make(async () => response(), { baseUrl }), /LOOPBACK_REQUIRED/);
  }
});
test('GET uses remote identity, no cookies, and preserves authoritative ETag', async () => {
  const client = make(async (url, init) => {
    assert.equal(url, 'http://127.0.0.1:58080/v1/me');
    assert.equal(init.headers.authorization, 'Synthetic principal_driver');
    assert.equal(init.credentials, 'omit'); assert.equal(init.redirect, 'error');
    return response();
  });
  assert.deepEqual(await client.request('/v1/me', decode), { value: { version: 1 }, etag: '"opaque-server-tag"', replayed: false });
});
test('rejects path escape before sending any request', async () => {
  const client = make(async () => assert.fail('must not fetch'));
  for (const path of ['https://example.com/v1/me', '//example.com', '/v1/../me', '/v1/%2e%2e/me', '/v1/me#secret', '/v1//me']) {
    await assert.rejects(client.request(path, decode), /INVALID_API_PATH/);
  }
});
test('command forwards original idempotency key and server ETag without retrying', async () => {
  let attempts = 0;
  const client = make(async (_url, init) => {
    attempts++; assert.equal(init.headers['if-match'], '"server-tag"');
    assert.equal(init.headers['idempotency-key'], 'stable-key');
    assert.equal(init.body, '{"command":"test"}'); throw new Error('network interruption');
  });
  await assert.rejects(client.request('/v1/commands/test', decode, { body: { command: 'test' }, idempotencyKey: 'stable-key', etag: '"server-tag"' }), { code: 'OUTCOME_UNKNOWN' });
  assert.equal(attempts, 1);
});
test('errors never fall back to local fixtures or expose server details', async () => {
  for (const [status, code] of [[401, 'SESSION_EXPIRED'], [409, 'REQUEST_CONFLICT'], [412, 'VERSION_CONFLICT'], [503, 'BACKEND_UNAVAILABLE']]) {
    const client = make(async () => response(status, { detail: 'sensitive information' }));
    await assert.rejects(client.request('/v1/me', decode), error => error.code === code && !error.message.includes('sensitive'));
  }
});
test('duplicate-proof conflicts are not falsely identified as stale versions or retried', async () => {
  let attempts = 0;
  const client = make(async () => {
    attempts++;
    return response(409, { code: 'PERSISTENCE_DUPLICATE', detail: 'RAW_SECRET_CANARY' });
  });
  await assert.rejects(client.request('/v1/commands/test', decode,
    { body: {}, idempotencyKey: 'original-proof' }), error =>
    error.status === 409 && error.code === 'REQUEST_CONFLICT' && error.message === 'REQUEST_CONFLICT');
  assert.equal(attempts, 1);
});
test('invalid success payload is not accepted as a receipt', async () => {
  const client = make(async () => response(200, {}));
  await assert.rejects(client.request('/v1/me', decode), { code: 'INVALID_API_RESPONSE' });
  await assert.rejects(client.request('/v1/commands/test', decode, { body: {}, idempotencyKey: 'stable' }), { code: 'OUTCOME_UNKNOWN' });
});
test('cancellation and deadline abort the actual fetch', async () => {
  const fetch = async (_url, { signal }) => new Promise((_resolve, reject) => {
    if (signal.aborted) reject(new Error('aborted'));
    else signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  });
  const client = make(fetch, { timeoutMs: 10 });
  await assert.rejects(client.request('/v1/me', decode), { code: 'BACKEND_UNAVAILABLE' });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(client.request('/v1/me', decode, undefined, controller.signal), { code: 'BACKEND_UNAVAILABLE' });
});
