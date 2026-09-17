/**
 * The provider-account adapter between the Firebase Admin session
 * (`@kavaroutes/google-identity`'s `lookupAccount`) and the revocation sweep's
 * account port. Added 2026-09-17 (UTC) with the adapter itself; no existing test
 * was changed.
 *
 * The load-bearing assertion is the failure direction: a provider that cannot be
 * interrogated must never be reported as ACTIVE, or the guarded profile would read
 * an outage as "this account is still fine".
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createGuardedProviderAccounts } from '../dist/guarded-accounts.js';

const identity = accounts => ({ async lookupAccount(subject) {
  const account = accounts[subject];
  if (account === undefined) throw new Error('GOOGLE_IDENTITY_LOOKUP_FAILED');
  return account;
} });

test('an enabled account is ACTIVE and a disabled account is DISABLED', async () => {
  const accounts = createGuardedProviderAccounts(identity({
    'subject-active': { disabled: false, revokedAt: null },
    'subject-disabled': { disabled: true, revokedAt: null }
  }));
  assert.equal(await accounts.checkAccount('subject-active'), 'ACTIVE');
  assert.equal(await accounts.checkAccount('subject-disabled'), 'DISABLED');
});

test('a provider failure is UNKNOWN, never ACTIVE', async () => {
  const accounts = createGuardedProviderAccounts(identity({}));
  assert.equal(await accounts.checkAccount('subject-missing'), 'UNKNOWN');
  assert.notEqual(await accounts.checkAccount('subject-missing'), 'ACTIVE');
});

test('the revocation timestamp is returned as-is, and absent means null', async () => {
  const stamp = '2026-09-17T01:00:00Z';
  const accounts = createGuardedProviderAccounts(identity({
    'subject-revoked': { disabled: false, revokedAt: stamp },
    'subject-fine': { disabled: false, revokedAt: null }
  }));
  assert.equal(await accounts.revokedAt('subject-revoked'), stamp);
  assert.equal(await accounts.revokedAt('subject-fine'), null);
});

test('a malformed revocation timestamp is refused instead of read as "no revocation"', async () => {
  const accounts = createGuardedProviderAccounts(identity({ 'subject-broken': { disabled: false, revokedAt: 'not a timestamp' } }));
  await assert.rejects(() => accounts.revokedAt('subject-broken'), /GUARDED_PROVIDER_REVOCATION_TIMESTAMP_INVALID/);
});

test('a provider session without lookupAccount is refused at construction', () => {
  assert.throws(() => createGuardedProviderAccounts(undefined), /GUARDED_PROVIDER_ACCOUNTS_INVALID/);
  assert.throws(() => createGuardedProviderAccounts({ verifyToken: async () => {} }), /GUARDED_PROVIDER_ACCOUNTS_INVALID/);
});
