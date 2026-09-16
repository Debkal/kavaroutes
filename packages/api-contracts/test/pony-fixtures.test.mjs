import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ponyCompanies, ponyPersonas, selectPonyPersona } from '../dist/pony-fixtures.js';
import { createSyntheticTestVerifier, authorize } from '../dist/security.js';
import { createWp007Api } from '../dist/index.js';

test('Pony catalog contains two companies and four distinct company-scoped principals', () => {
  assert.deepEqual(ponyCompanies.map(c => [c.name, c.tier]), [['PonyTransport', 'SMALL_BUSINESS'], ['PonyBigBusiness', 'ENTERPRISE']]);
  assert.equal(ponyPersonas.length, 4);
  assert.equal(new Set(ponyPersonas.map(p => p.principalId)).size, 4);
  assert.equal(new Set(ponyPersonas.map(p => p.token)).size, 4);
  for (const company of ponyCompanies) {
    assert.equal(selectPonyPersona(company.key, 'driver').displayName, 'PonyDriver');
    assert.equal(selectPonyPersona(company.key, 'dispatcher').displayName, 'PonyDispatch');
  }
  assert.throws(() => selectPonyPersona('ponytransport', 'admin'), /PONY_PERSONA_NOT_FOUND/);
  assert.throws(() => selectPonyPersona('unknown', 'driver'), /PONY_PERSONA_NOT_FOUND/);
});

test('Pony personas require explicit verifier activation; existing fixtures remain intact', async () => {
  const verifier = createSyntheticTestVerifier();
  for (const persona of ponyPersonas) assert.equal(await verifier.verify(`Synthetic ${persona.token}`), null);
  assert.ok(await verifier.verify('Synthetic principal_dispatcher'));
});

test('real API session projection identifies each Pony principal and denies cross-company requests', async t => {
  const calls = [];
  const app = await createWp007Api({ verifier: createSyntheticTestVerifier({ enablePonyFixtures: true }),
    application: { async listTrips(organizationId) { calls.push(organizationId); return []; } } });
  t.after(() => app.close());
  for (const persona of ponyPersonas) {
    const headers = { authorization: `Synthetic ${persona.token}` };
    const session = await app.inject({ method: 'GET', url: '/v1/me', headers });
    assert.equal(session.statusCode, 200);
    assert.equal(session.json().principalId, persona.principalId);
    assert.deepEqual(session.json().organizations.map(o => o.organizationId), [persona.organizationId]);
    const other = ponyCompanies.find(c => c.organizationId !== persona.organizationId);
    const denied = await app.inject({ method: 'GET', url: `/v1/organizations/${other.organizationId}/trips`, headers });
    assert.equal(denied.statusCode, 404);
    const own = await app.inject({ method: 'GET', url: `/v1/organizations/${persona.organizationId}/trips`, headers });
    assert.equal(own.statusCode, persona.role === 'dispatcher' ? 200 : 404);
  }
  assert.deepEqual(calls, ponyCompanies.map(c => c.organizationId));
});

test('each Pony role is bounded to its own company and driver subject without implicit override', async () => {
  const verifier = createSyntheticTestVerifier({ enablePonyFixtures: true });
  for (const persona of ponyPersonas) {
    const principal = await verifier.verify(`Synthetic ${persona.token}`);
    assert.equal(principal.id, persona.principalId);
    assert.equal(principal.organizationId, persona.organizationId);
    assert.equal(principal.capabilities.has('driver-policy:override'), false);
    assert.equal(principal.capabilities.has('driver-route:self-approve'), false, 'self approval needs separately seeded capability/policy');
    const requirement = { capability: persona.role === 'driver' ? 'driver:execute' : 'dispatch:command', purpose: 'ASSIGNED_SERVICE_DELIVERY' };
    assert.doesNotThrow(() => authorize(principal, persona.organizationId, requirement));
    for (const other of ponyCompanies.filter(c => c.organizationId !== persona.organizationId)) {
      assert.throws(() => authorize(principal, other.organizationId, requirement));
    }
    if (persona.role === 'driver') {
      assert.equal(principal.subjectId, persona.subjectId);
      assert.throws(() => authorize(principal, persona.organizationId, { ...requirement, capability: 'dispatch:command' }));
      assert.throws(() => authorize(principal, persona.organizationId, { ...requirement, subjectId: 'wrong-driver' }));
    }
  }
  assert.equal(await verifier.verify('Synthetic principal_ponytransport_admin'), null);
});
