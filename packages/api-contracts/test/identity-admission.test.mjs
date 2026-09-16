import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createIdentityAdmission } from '../dist/identity-admission.js';
const organizationId = '71000000-0000-4000-8000-000000000001';
const identity = { issuer: 'https://securetoken.google.com/kavaroutes', audience: 'kavaroutes', subject: 'verified-subject',
  emailVerified: true, expiresAt: 2000, authenticatedAt: 900 };
const membership = { userId: '71000000-0000-4000-8000-000000000020', principalId: '71000000-0000-4000-8000-000000000012',
  organizationId, identityIssuer: identity.issuer, identitySubject: identity.subject,
  userActive: true, membershipActive: true, authorizationGeneration: 3 };
function setup(claims = identity, row = membership) {
  const lookups = [];
  const admission = createIdentityAdmission({ verifyToken: async () => claims,
    findMembership: async (...args) => { lookups.push(args); return row; } },
  { issuer: identity.issuer, audience: identity.audience, now: () => 1000, maximumAuthenticationAgeSeconds: 300 });
  return { admission, lookups };
}
test('verified identity requires an exact active issuer/subject/company membership', async () => {
  const { admission, lookups } = setup();
  assert.deepEqual(await admission.admit('verified-token', organizationId), {
    userId: membership.userId, principalId: membership.principalId, organizationId, authorizationGeneration: 3,
    issuer: identity.issuer, subject: identity.subject });
  assert.deepEqual(lookups, [[identity.issuer, identity.subject, organizationId]]);
});
test('invalid provider claims are denied before membership lookup', async () => {
  for (const patch of [{ issuer: 'https://untrusted.example' }, { audience: 'other-project' }, { emailVerified: false },
    { expiresAt: 1000 }, { authenticatedAt: 699 }, { authenticatedAt: 1001 }, { subject: '' }]) {
    const { admission, lookups } = setup({ ...identity, ...patch });
    await assert.rejects(admission.admit('token', organizationId), /SIGN_IN_NOT_AUTHORIZED/);
    assert.equal(lookups.length, 0);
  }
});
test('no signup, inactive user/membership, wrong tenant, wrong binding and invalid generation fail closed', async () => {
  for (const row of [null, ...[{ userActive: false }, { membershipActive: false }, { organizationId: '72000000-0000-4000-8000-000000000001' },
    { identitySubject: 'other-user' }, { identityIssuer: 'https://other.example' }, { authorizationGeneration: 0 }].map(p => ({ ...membership, ...p }))]) {
    await assert.rejects(setup(identity, row).admission.admit('token', organizationId), /SIGN_IN_NOT_AUTHORIZED/);
  }
});
test('provider failure is closed and never exposes tokens or raw errors', async () => {
  const admission = createIdentityAdmission({ verifyToken: async () => { throw new Error('RAW_SECRET_CANARY'); },
    findMembership: async () => assert.fail('must not look up') },
  { issuer: identity.issuer, audience: identity.audience, now: () => 1000, maximumAuthenticationAgeSeconds: 300 });
  await assert.rejects(admission.admit('secret-token', organizationId), e => e.message === 'SIGN_IN_NOT_AUTHORIZED');
});
