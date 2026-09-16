import assert from 'node:assert/strict';
import test from 'node:test';
import { createProviderRevocationSweeper } from '../dist/provider-session-revocation.js';

function fixture(options = {}) {
  const clock = { now: 1_000_000 };
  const revokedSubjects = [];
  let revokeAllCalls = 0;
  const states = new Map(Object.entries(options.states ?? {}));
  const ports = {
    listed: options.listed ?? ['subject-active', 'subject-disabled'],
    failListing: false,
    providerDown: options.providerDown === true,
    revocationArgs: [],
    /** Fair traversal: a page starts strictly after the resumed cursor. */
    async listActiveSubjects(limit, after = null) {
      if (this.failListing) throw new Error('PROVIDER_UNREACHABLE');
      const from = after === null ? 0 : this.listed.indexOf(after) + 1;
      return this.listed.slice(from, from + limit);
    },
    async checkAccount(subject) {
      if (this.providerDown) throw new Error('PROVIDER_UNREACHABLE');
      if (options.hangingSubjects?.includes(subject)) return new Promise(() => {});
      return states.get(subject) ?? 'UNKNOWN';
    },
    async providerRevokedAt(subject) {
      if (this.providerDown) throw new Error('PROVIDER_UNREACHABLE');
      return (options.revocations ?? {})[subject] ?? null;
    },
    async revokeSubject(subject, revokedAt) { revokedSubjects.push(subject); this.revocationArgs.push({ subject, revokedAt }); return 1; },
    async revokeAllActive() { revokeAllCalls += 1; return 3; },
  };
  const sweeper = createProviderRevocationSweeper(ports, { maximumStalenessMilliseconds: 300_000, batchSize: options.batchSize ?? 10,
    ...(options.checkDeadlineMilliseconds === undefined ? {} : { checkDeadlineMilliseconds: options.checkDeadlineMilliseconds }),
    now: () => clock.now });
  return { sweeper, ports, clock, revokedSubjects, revokeAllCount: () => revokeAllCalls };
}

test('a disabled provider account loses its sessions on the first sweep', async () => {
  const f = fixture({ states: { 'subject-active': 'ACTIVE', 'subject-disabled': 'DISABLED' } });
  const result = await f.sweeper.runOnce();
  assert.deepEqual(f.revokedSubjects, ['subject-disabled']);
  assert.equal(result.revoked, 1);
  assert.equal(result.state, 'CURRENT');
});

test('a provider outage is bounded: degraded, then fail closed exactly once', async () => {
  const f = fixture({ providerDown: true });
  const degraded = await f.sweeper.runOnce();
  assert.equal(degraded.state, 'DEGRADED');
  assert.equal(f.revokeAllCount(), 0, 'a short outage must not mass-revoke');
  f.clock.now += 60_000;
  assert.equal((await f.sweeper.runOnce()).state, 'DEGRADED');
  assert.equal(f.revokeAllCount(), 0);
  f.clock.now += 300_000;
  const closed = await f.sweeper.runOnce();
  assert.equal(closed.state, 'FAILED_CLOSED');
  assert.equal(f.revokeAllCount(), 1);
  f.clock.now += 60_000;
  assert.equal((await f.sweeper.runOnce()).state, 'FAILED_CLOSED');
  assert.equal(f.revokeAllCount(), 1, 'fail-closed revocation must not repeat on every sweep');
});

test('recovery clears the outage and a later outage can fail closed again', async () => {
  const f = fixture({ states: { 'subject-active': 'ACTIVE', 'subject-disabled': 'ACTIVE' } });
  f.ports.listed = ['subject-active'];
  assert.equal((await f.sweeper.runOnce()).state, 'CURRENT');
  f.ports.failListing = true;
  assert.equal((await f.sweeper.runOnce()).state, 'DEGRADED');
  f.clock.now += 400_000;
  assert.equal((await f.sweeper.runOnce()).state, 'FAILED_CLOSED');
  assert.equal(f.revokeAllCount(), 1);
  f.ports.failListing = false;
  assert.equal((await f.sweeper.runOnce()).state, 'CURRENT');
  assert.equal(f.sweeper.status().outageStartedAt, null);
  f.ports.failListing = true;
  assert.equal((await f.sweeper.runOnce()).state, 'DEGRADED');
  f.clock.now += 400_000;
  assert.equal((await f.sweeper.runOnce()).state, 'FAILED_CLOSED');
  assert.equal(f.revokeAllCount(), 2);
});

test('sweeper bounds are validated and a listing error is treated as an outage', async () => {
  const f = fixture({});
  assert.throws(() => createProviderRevocationSweeper(f.ports, { maximumStalenessMilliseconds: 1_000 }), /PROVIDER_REVOCATION_CONFIG_INVALID/);
  assert.throws(() => createProviderRevocationSweeper(f.ports, { maximumStalenessMilliseconds: 300_000, batchSize: 0 }), /PROVIDER_REVOCATION_CONFIG_INVALID/);
  f.ports.failListing = true;
  const result = await f.sweeper.runOnce();
  assert.equal(result.state, 'DEGRADED');
  assert.equal(result.checked, 0);
});

test('a sweep resumes fairly so every subject is revisited within one pass', async () => {
  const listed = ['s1', 's2', 's3', 's4', 's5'];
  const f = fixture({ listed, states: Object.fromEntries(listed.map(subject => [subject, 'ACTIVE'])), batchSize: 2 });
  const checked = [];
  const check = f.ports.checkAccount.bind(f.ports);
  f.ports.checkAccount = async subject => { checked.push(subject); return check(subject); };
  await f.sweeper.runOnce();
  await f.sweeper.runOnce();
  await f.sweeper.runOnce();
  assert.deepEqual(checked, listed, 'five subjects and a batch of two must cover every subject in three sweeps');
  assert.equal(f.sweeper.status().passes, 1);
  assert.equal(f.sweeper.status().cursor, null, 'a short page ends the pass');
  await f.sweeper.runOnce();
  assert.deepEqual(checked.slice(listed.length), ['s1', 's2'], 'the next pass restarts at the first subject');
});

test('a hanging provider call is deadline bounded and never reads as valid', async () => {
  const f = fixture({ listed: ['subject-hang'], hangingSubjects: ['subject-hang'], checkDeadlineMilliseconds: 50 });
  const started = Date.now();
  const sweep = await f.sweeper.runOnce();
  const elapsed = Date.now() - started;
  assert.equal(sweep.state, 'DEGRADED');
  assert.equal(sweep.revoked, 0);
  assert.ok(elapsed < 2_000, `a hanging provider must not hold the sweep (took ${elapsed}ms)`);
  const decision = await f.sweeper.authorize({ subject: 'subject-hang', sessionAuthenticatedAt: new Date().toISOString() });
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, 'PROVIDER_UNVERIFIED');
  assert.ok(decision.retryAfterSeconds >= 1);
});

test('admission follows the provider: disabled and revoked deny, a fresh account allows', async () => {
  const authenticatedAt = '2026-09-16T10:00:01.000Z';
  const healthy = fixture({ listed: ['s'], states: { s: 'ACTIVE' } });
  const allowed = await healthy.sweeper.authorize({ subject: 's', sessionAuthenticatedAt: authenticatedAt });
  assert.deepEqual({ allowed: allowed.allowed, reason: allowed.reason }, { allowed: true, reason: 'PROVIDER_ACTIVE' });
  const disabled = fixture({ listed: ['s'], states: { s: 'DISABLED' } });
  assert.equal((await disabled.sweeper.authorize({ subject: 's', sessionAuthenticatedAt: authenticatedAt })).reason, 'PROVIDER_ACCOUNT_DISABLED');
  const unreachable = fixture({ listed: ['s'], states: { s: 'ACTIVE' }, providerDown: true, checkDeadlineMilliseconds: 50 });
  const unverified = await unreachable.sweeper.authorize({ subject: 's', sessionAuthenticatedAt: authenticatedAt });
  assert.equal(unverified.allowed, false);
  assert.equal(unverified.reason, 'PROVIDER_UNVERIFIED', 'an unreachable provider is never read as still valid');
});

test('a provider revocation at or after session authentication denies that session', async () => {
  const f = fixture({ listed: ['s'], states: { s: 'ACTIVE' }, revocations: { s: '2026-09-16T10:00:00.000Z' } });
  const older = await f.sweeper.authorize({ subject: 's', sessionAuthenticatedAt: '2026-09-16T09:59:59.000Z' });
  assert.deepEqual({ allowed: older.allowed, reason: older.reason }, { allowed: false, reason: 'PROVIDER_AUTHENTICATION_REVOKED' });
  // `validSince` is second-granular: the same second as the revocation is ambiguous.
  const ambiguous = await f.sweeper.authorize({ subject: 's', sessionAuthenticatedAt: '2026-09-16T10:00:00.750Z' });
  assert.equal(ambiguous.allowed, false);
  const newer = await f.sweeper.authorize({ subject: 's', sessionAuthenticatedAt: '2026-09-16T10:00:02.000Z' });
  assert.deepEqual({ allowed: newer.allowed, reason: newer.reason }, { allowed: true, reason: 'PROVIDER_ACTIVE' },
    'a session authenticated after the revocation stays valid');
  const sweep = await f.sweeper.runOnce();
  assert.equal(sweep.revoked, 1, 'the sweep revokes the sessions that predate the revocation');
  assert.deepEqual(f.ports.revocationArgs, [{ subject: 's', revokedAt: '2026-09-16T10:00:00.000Z' }]);
});

test('fail-closed denies admission, and a restart denies until the provider answers', async () => {
  const f = fixture({ listed: ['s'], states: { s: 'ACTIVE' }, providerDown: true, checkDeadlineMilliseconds: 50 });
  await f.sweeper.runOnce();
  f.clock.now += 400_000;
  assert.equal((await f.sweeper.runOnce()).state, 'FAILED_CLOSED');
  assert.equal(f.revokeAllCount(), 1);
  const denied = await f.sweeper.authorize({ subject: 's', sessionAuthenticatedAt: new Date(f.clock.now).toISOString() });
  assert.equal(denied.reason, 'PROVIDER_FAILED_CLOSED');
  // Restart: evidence and the outage clock are gone, so the first request is
  // verified inline and refused while the provider cannot answer.
  const restarted = createProviderRevocationSweeper(f.ports, { maximumStalenessMilliseconds: 300_000, batchSize: 10,
    checkDeadlineMilliseconds: 50, now: () => f.clock.now });
  assert.equal(restarted.status().state, 'CURRENT');
  assert.equal(restarted.evidence('s'), null);
  assert.equal((await restarted.authorize({ subject: 's', sessionAuthenticatedAt: new Date(f.clock.now).toISOString() })).reason,
    'PROVIDER_UNVERIFIED');
  f.ports.providerDown = false;
  const recovered = await restarted.authorize({ subject: 's', sessionAuthenticatedAt: new Date(f.clock.now).toISOString() });
  assert.deepEqual({ allowed: recovered.allowed, reason: recovered.reason }, { allowed: true, reason: 'PROVIDER_ACTIVE' });
  assert.equal(restarted.status().state, 'CURRENT');
});
