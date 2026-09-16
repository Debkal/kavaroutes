import assert from 'node:assert/strict';
import test from 'node:test';
import { toWireItineraryLeg } from '../dist/guarded-driver-itinerary.js';

const rule = { pickupRequired: true, dropoffRequired: false, mobilitySecurementRequired: false,
  allowedRoles: ['RIDER', 'RIDER_UNABLE_TO_SIGN'], unableReasons: ['PHYSICALLY_UNABLE'],
  noShowWaitMinutes: 15, noShowAllowed: false, noShowAuthorizationReference: null };

const leg = overrides => ({ assignmentId: '11111111-1111-4111-8111-111111111111', assignmentVersion: 2,
  runId: '22222222-2222-4222-8222-222222222222', runVersion: 3, runLifecycle: 'planned',
  vehicleId: null, vehicleLabel: null, tripId: '33333333-3333-4333-8333-333333333333',
  tripLegId: '44444444-4444-4444-8444-444444444444', ordinal: 1, riderLabel: 'rider-synthetic-1',
  pickupLabel: 'pickup-synthetic', dropoffLabel: 'dropoff-synthetic', plannedStartAt: '2026-09-16T15:00:00.000Z',
  plannedEndAt: '2026-09-16T16:00:00.000Z', serviceTimezone: 'America/Los_Angeles', ...overrides });

test('a persisted leg with a valid stored rule maps to the closed wire shape', () => {
  const wire = toWireItineraryLeg(leg({ execution: { executionId: '55555555-5555-4555-8555-555555555555', lifecycle: 'ARRIVED_PICKUP', version: 4,
    serviceControl: { riderVerified: true, boardingSecure: true, safelyUnloaded: false, incidentOpen: false,
      pickupEvidenceId: null, dropoffEvidenceId: null, proofRule: { version: 1, digest: 'a'.repeat(64), rule } } } }));
  assert.equal(wire.vehicleId, null);
  assert.equal(wire.execution.version, 4);
  assert.deepEqual(wire.execution.serviceControl.proofRule, { version: 1, digest: 'a'.repeat(64), rule });
  assert.equal('expectedTag' in wire.execution, false, 'the route handler adds the tag');
});

test('a leg without a dispatched execution maps to null instead of an empty object', () => {
  assert.equal(toWireItineraryLeg(leg({})).execution, null);
  assert.equal(toWireItineraryLeg(leg({ execution: null })).execution, null);
});

test('a stored rule outside the contract is refused instead of silently dropped', () => {
  const stored = value => ({ executionId: '55555555-5555-4555-8555-555555555555', lifecycle: 'ARRIVED_PICKUP', version: 1,
    serviceControl: { riderVerified: false, boardingSecure: false, safelyUnloaded: false, incidentOpen: false,
      pickupEvidenceId: null, dropoffEvidenceId: null, proofRule: { version: 1, digest: 'a'.repeat(64), rule: value } } });
  for (const value of [{ ...rule, allowedRoles: ['SUPERVISOR'] }, { ...rule, extra: true },
    { ...rule, noShowWaitMinutes: 0 }, { ...rule, noShowAllowed: true, noShowAuthorizationReference: null }])
    assert.throws(() => toWireItineraryLeg(leg({ execution: stored(value) })), /PROOF_POLICY_STORAGE_INVALID/);
  assert.equal(toWireItineraryLeg(leg({ execution: stored(rule) })).execution.serviceControl.proofRule.rule.allowedRoles.length, 2);
});
