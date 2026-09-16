import test from 'node:test';
import assert from 'node:assert/strict';
import { createWp007Api, syntheticIds } from '../dist/index.js';

const path = `/v1/organizations/${syntheticIds.organizationA}/driver/itineraries/2026-09-13`;
test('itinerary identity comes from authenticated subject, not client parameters', async t => {
  const reads = [];
  const app = await createWp007Api({ driverItineraryReader: async (...scope) => { reads.push(scope); return []; } });
  t.after(() => app.close());
  const result = await app.inject({ url: path, headers: { authorization: 'Synthetic principal_driver' } });
  assert.equal(result.statusCode, 200, result.body);
  assert.deepEqual(result.json(), { driverReference: syntheticIds.driverSubject, serviceDate: '2026-09-13', legs: [] });
  assert.deepEqual(reads, [[syntheticIds.organizationA, syntheticIds.driverSubject, '2026-09-13']]);
  assert.equal(result.headers['cache-control'], 'no-store');
});
test('unauthenticated, wrong-tenant and other personas cannot read itinerary', async t => {
  let reads = 0;
  const app = await createWp007Api({ driverItineraryReader: async () => { reads++; return []; } });
  t.after(() => app.close());
  for (const principal of [null, 'principal_dispatcher', 'principal_facility', 'principal_outsider']) {
    const result = await app.inject({ url: path, headers: principal ? { authorization: `Synthetic ${principal}` } : {} });
    assert.equal(result.statusCode, principal ? 404 : 401);
  }
  const wrongTenant = await app.inject({ url: path.replace(syntheticIds.organizationA, syntheticIds.organizationB), headers: { authorization: 'Synthetic principal_driver' } });
  assert.equal(wrongTenant.statusCode, 404); assert.equal(reads, 0);
});
test('missing persisted reader fails closed instead of returning synthetic manifest', async t => {
  const app = await createWp007Api(); t.after(() => app.close());
  const result = await app.inject({ url: path, headers: { authorization: 'Synthetic principal_driver' } });
  assert.equal(result.statusCode, 503); assert.equal(result.json().code, 'RUNTIME_PATH_NOT_PROMOTED');
});
