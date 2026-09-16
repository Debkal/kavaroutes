import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGoogleIdentityVerifier } from '../dist/google-identity-verifier.js';
const claims = { iss: 'https://securetoken.google.com/kavaroutes', aud: 'kavaroutes', sub: 'provider-subject', uid: 'provider-subject',
  email_verified: true, email: 'not-returned@example.invalid', exp: 2000, auth_time: 900, firebase: { sign_in_provider: 'password' }, role: 'ADMIN' };
test('both selected providers require SDK revocation checking and return only identity fields', async () => {
  for (const provider of ['password','google.com']) {
    const calls = [];
    const verify = createGoogleIdentityVerifier({ verifyIdToken: async (...args) => {
      calls.push(args); return { ...claims, firebase: { sign_in_provider: provider } };
    } }, 'kavaroutes');
    assert.deepEqual(await verify('test-id-token'), { issuer: claims.iss, audience: claims.aud, subject: claims.sub,
      emailVerified: true, expiresAt: claims.exp, authenticatedAt: claims.auth_time });
    assert.deepEqual(calls, [['test-id-token',true]]);
  }
});
test('wrong project, unsigned/malformed output, unverified email and unapproved providers fail closed', async () => {
  const invalid = [null, [], {}, ...[{ iss: 'https://wrong.example' }, { aud: 'other-project' }, { uid: 'other-subject' },
    { email_verified: false }, { auth_time: '900' }, { firebase: { sign_in_provider: 'anonymous' } },
    { firebase: { sign_in_provider: 'custom' } }, { firebase: { sign_in_provider: 'google.com', tenant: 'unapproved' } }].map(p => ({ ...claims,...p }))];
  for (const value of invalid) {
    await assert.rejects(createGoogleIdentityVerifier({ verifyIdToken: async () => value }, 'kavaroutes')('token'), /SIGN_IN_NOT_AUTHORIZED/);
  }
});
test('revocation/provider failures are not converted to offline authentication or leaked', async () => {
  let calls = 0;
  const verify = createGoogleIdentityVerifier({ verifyIdToken: async () => { calls++; throw new Error('RAW_SECRET_CANARY'); } }, 'kavaroutes');
  await assert.rejects(verify('private-token'), e => e.message === 'SIGN_IN_NOT_AUTHORIZED');
  assert.equal(calls,1);
  await assert.rejects(verify('bad token'), /SIGN_IN_NOT_AUTHORIZED/);
  assert.equal(calls,1);
});
