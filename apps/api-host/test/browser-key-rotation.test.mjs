/**
 * CQ-003 item 3 asks the guarded profile to validate "startup config/activation,
 * protected key persistence/rotation". The signing key is what binds both the
 * login-challenge signature and the per-session CSRF derivation, so the rotation
 * contract has to be explicit and fail closed: a key change must refuse every
 * credential minted under the old key rather than accept it under the new one,
 * and it must not break the minting path for new sessions.
 *
 * Added 2026-09-17; no existing test was changed.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { createBrowserCredentials, hashBrowserCredential } from '../dist/browser-credentials.js';
import { createBrowserPrincipalVerifier } from '../dist/browser-principal.js';

const origin = 'https://app.kavaroutes.com';
const organizationId = '71000000-0000-4000-8000-000000000001';
const cookie = (value) => value.split(';')[0];

// Mimics the persisted session row: the store compares the derived CSRF hash, so
// a key change makes the lookup miss instead of matching something weaker.
function sessionStore(issued) {
  const row = { organizationId, principalId: randomUUID(), role: 'DISPATCHER', driverId: null,
    authorizationGeneration: 1, expiresAt: new Date(Date.now() + 3600_000).toISOString(), scopeKinds: [], capabilityGrants: [] };
  const calls = [];
  return { calls, resolve: async (org, tokenHash, csrfHash) => {
    calls.push({ org, tokenHash, csrfHash });
    return org === organizationId && tokenHash === issued.tokenHash && csrfHash === issued.csrfHash ? row : null;
  } };
}

test('a rotated signing key refuses credentials minted under the previous key', async () => {
  const previous = randomBytes(32), rotated = randomBytes(32);
  const issued = createBrowserCredentials({ origin, signingKey: previous }).issue(organizationId);
  const store = sessionStore(issued);
  const verifier = createBrowserPrincipalVerifier({ origin, signingKey: rotated, resolve: store.resolve });
  const response = await verifier.verifyRequest({ method: 'GET', headers: { cookie: cookie(issued.cookie), 'sec-fetch-site': 'same-origin' } });
  assert.equal(response, null, 'a session minted under the old key must not authenticate under the new one');
  assert.ok(store.calls.length <= 1, 'the rotated key must not be retried against the store with guesses');
  // The refusal is fail-closed, not a partial principal: nothing was returned.
  assert.equal(await verifier.verifyRequest({ method: 'GET', headers: { cookie: cookie(issued.cookie) } }), null);
});

test('a rotated signing key still refuses the previous key\u2019s login challenge', () => {
  const previous = randomBytes(32), rotated = randomBytes(32);
  const challenge = createBrowserCredentials({ origin, signingKey: previous }).challenge();
  const after = createBrowserCredentials({ origin, signingKey: rotated });
  assert.throws(() => after.verifyChallenge(cookie(challenge.cookie), challenge.csrf), /DENIED/);
  // Same key, same cookie: the challenge is still valid, so the refusal above is
  // about the key and not about the cookie shape or the clock.
  createBrowserCredentials({ origin, signingKey: previous }).verifyChallenge(cookie(challenge.cookie), challenge.csrf);
});

test('after rotation the new key issues sessions the verifier accepts', async () => {
  const rotated = randomBytes(32);
  const issued = createBrowserCredentials({ origin, signingKey: rotated }).issue(organizationId);
  const verifier = createBrowserPrincipalVerifier({ origin, signingKey: rotated, resolve: sessionStore(issued).resolve });
  const principal = await verifier.verifyRequest({ method: 'GET', headers: { cookie: cookie(issued.cookie), 'sec-fetch-site': 'same-origin' } });
  assert.ok(principal, 'the post-rotation session must authenticate');
  assert.equal(principal.kind, 'BROWSER_USER');
  assert.equal(principal.organizationId, organizationId);
  // A state-changing request additionally needs the CSRF value derived from the
  // same key, so recovery after rotation is complete and not read-only.
  const post = await verifier.verifyRequest({ method: 'POST', headers: { cookie: cookie(issued.cookie), origin, 'x-kr-csrf': issued.csrf } });
  assert.ok(post, 'CSRF derived under the new key must be accepted for writes');
});

test('rotation cannot be approximated by a weaker key or by a stale CSRF value', async () => {
  const previous = randomBytes(32), rotated = randomBytes(32);
  const issued = createBrowserCredentials({ origin, signingKey: previous }).issue(organizationId);
  assert.throws(() => createBrowserCredentials({ origin, signingKey: rotated.subarray(0, 16) }), /CONFIG_INVALID/);
  const verifier = createBrowserPrincipalVerifier({ origin, signingKey: rotated, resolve: sessionStore(issued).resolve });
  const forged = await verifier.verifyRequest({ method: 'POST',
    headers: { cookie: cookie(issued.cookie), origin, 'x-kr-csrf': issued.csrf } });
  assert.equal(forged, null, 'the old CSRF value must not be accepted after rotation');
  // The cookie itself carries no key id and no signature, so there is nothing in
  // it to replay: the derived CSRF hash is the only thing that can match a row.
  assert.equal(hashBrowserCredential(issued.csrf), issued.csrfHash);
});
