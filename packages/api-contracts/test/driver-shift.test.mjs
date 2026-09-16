import test from 'node:test';
import assert from 'node:assert/strict';
import { createWp007Api, syntheticIds } from '../dist/index.js';

const url = `/v1/organizations/${syntheticIds.organizationA}/driver/shifts/commands/start`;
const body = { assignmentId: '40000000-0000-4000-8000-000000000001', serviceDate: '2026-09-13', expectedAssignmentVersion: 1 };
const policy = {
  schemaVersion: 1, organizationId: syntheticIds.organizationA, driverId: syntheticIds.driverSubject,
  assignmentId: body.assignmentId, commercialTier: 'ENTERPRISE', workforceRelationship: 'EMPLOYEE', policyVersion: 1,
  resolvedAt: '2026-09-13T17:00:00.000Z',
  preInspection: { mode: 'REQUIRED', source: 'TIER_DEFAULT', reasonCode: 'ENTERPRISE_STRICT_DEFAULT', locked: true },
  postInspection: { mode: 'REQUIRED', source: 'TIER_DEFAULT', reasonCode: 'ENTERPRISE_STRICT_DEFAULT', locked: true },
  startOdometer: { mode: 'REQUIRED', source: 'TIER_DEFAULT', reasonCode: 'ENTERPRISE_STRICT_DEFAULT', locked: true },
  endOdometer: { mode: 'REQUIRED', source: 'TIER_DEFAULT', reasonCode: 'ENTERPRISE_STRICT_DEFAULT', locked: true },
  returnVerification: { mode: 'REQUIRED_WITH_AUDITED_OVERRIDE', source: 'TIER_DEFAULT', reasonCode: 'ENTERPRISE_STRICT_DEFAULT', locked: true },
  routeChange: { mode: 'DISPATCH_APPROVAL_REQUIRED', source: 'TIER_DEFAULT', reasonCode: 'ENTERPRISE_STRICT_DEFAULT', locked: true },
  proofOfServicePolicy: 'PAYER_CONTRACT_ORGANIZATION_RESOLVED',
  nonWaivableControls: ['IDENTITY_AND_AUTHORIZATION','TENANT_ISOLATION','ENCRYPTION_AND_AUDIT','MINIMUM_NECESSARY','NO_PHI_NAVIGATION','TRACKING_TRANSPARENCY','EMERGENCY_STOP'],
  canonicalDigest: 'a'.repeat(64),
};
test('Driver starts only its authenticated persisted shift and receives server policy', async t => {
  const calls = [];
  const service = { start: async input => { calls.push(input); return { replayed: false, statusCode: 200, headers: {}, body: {
    outcome: 'APPLIED', shiftReference: '50000000-0000-4000-8000-000000000001', shiftGeneration: '50000000-0000-4000-8000-000000000002', resourceVersion: 1, effectivePolicy: policy } }; } };
  const app = await createWp007Api({ driverShiftService: service }); t.after(() => app.close());
  const result = await app.inject({ method: 'POST', url, headers: { authorization: 'Synthetic principal_driver', 'idempotency-key': 'start-shift-test-0001' }, payload: body });
  assert.equal(result.statusCode, 200, result.body); assert.equal(result.json().effectivePolicy.commercialTier, 'ENTERPRISE');
  assert.equal(calls[0].principal.subjectId, syntheticIds.driverSubject); assert.deepEqual(calls[0].request, body);
});
test('missing service and wrong personas fail closed', async t => {
  const app = await createWp007Api(); t.after(() => app.close());
  let result = await app.inject({ method: 'POST', url, headers: { authorization: 'Synthetic principal_driver', 'idempotency-key': 'start-shift-test-0002' }, payload: body });
  assert.equal(result.statusCode, 503);
  for (const principal of ['principal_dispatcher', 'principal_facility', 'principal_outsider']) {
    result = await app.inject({ method: 'POST', url, headers: { authorization: `Synthetic ${principal}`, 'idempotency-key': 'start-shift-test-0003' }, payload: body });
    assert.equal(result.statusCode, 404);
  }
});
test('request is closed and requires stable idempotency identity', async t => {
  const app = await createWp007Api({ driverShiftService: { start: async () => assert.fail('invalid request reached service') } }); t.after(() => app.close());
  for (const request of [
    { headers: { authorization: 'Synthetic principal_driver' }, payload: body },
    { headers: { authorization: 'Synthetic principal_driver', 'idempotency-key': 'short' }, payload: body },
    { headers: { authorization: 'Synthetic principal_driver', 'idempotency-key': 'start-shift-test-0004' }, payload: { ...body, tier: 'SMALL_BUSINESS' } },
  ]) assert.ok((await app.inject({ method: 'POST', url, ...request })).statusCode >= 400);
});
