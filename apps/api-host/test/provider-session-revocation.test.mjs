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
    async listActiveSubjects(limit) { if (this.failListing) throw new Error('PROVIDER_UNREACHABLE'); return this.listed.slice(0, limit); },
    async checkAccount(subject) { if (options.providerDown) throw new Error('PROVIDER_UNREACHABLE'); return states.get(subject) ?? 'UNKNOWN'; },
    async revokeSubject(subject) { revokedSubjects.push(subject); return 1; },
    async revokeAllActive() { revokeAllCalls += 1; return 3; },
  };
  const sweeper = createProviderRevocationSweeper(ports, { maximumStalenessMilliseconds: 300_000, batchSize: 10, now: () => clock.now });
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
