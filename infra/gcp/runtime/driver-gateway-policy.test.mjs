import test from 'node:test';
import assert from 'node:assert/strict';
import {driverGatewayDecision} from './driver-gateway-policy.mjs';

const business='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const other='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const driver='11111111-1111-4111-8111-111111111111';
const shift='22222222-2222-4222-8222-222222222222';
const session=`DriverSession dvs_${'a'.repeat(43)}`;
const admin=`DriverAdmin ${'a'.repeat(43)}`;

test('Driver host requires business access for pages and login APIs',()=>{
  assert.equal(driverGatewayDecision('GET','/driver'),'deny');
  assert.equal(driverGatewayDecision('GET','/driver-admin'),'deny');
  assert.equal(driverGatewayDecision('GET','/assets/index.js'),'deny');
  assert.equal(driverGatewayDecision('POST',`/v1/organizations/${business}/driver-logins/commands/verify`),'deny');
  assert.equal(driverGatewayDecision('POST','/driver-admin/session'),'deny');
  assert.equal(driverGatewayDecision('GET','/driver',undefined,business),'static');
  assert.equal(driverGatewayDecision('GET','/driver-admin',undefined,business),'static');
  assert.equal(driverGatewayDecision('POST',`/v1/organizations/${business}/driver-logins/commands/verify`,undefined,business),'proxy');
  assert.equal(driverGatewayDecision('POST',`/v1/organizations/${business}/driver-logins/${driver}/commands/claim`,undefined,business),'proxy');
  assert.equal(driverGatewayDecision('POST',`/v1/organizations/${other}/driver-logins/commands/verify`,undefined,business),'deny');
  assert.equal(driverGatewayDecision('POST','/driver-admin/session',undefined,business),'proxy');
  assert.equal(driverGatewayDecision('POST','/driver-admin/drivers',admin,business),'proxy');
  assert.equal(driverGatewayDecision('POST','/driver-admin/drivers',session,business),'deny');
});

test('existing DriverSession can upload location without business browser cookie',()=>{
  assert.equal(driverGatewayDecision('GET',`/v1/organizations/${business}/driver/itineraries/2026-09-26`,session),'proxy');
  assert.equal(driverGatewayDecision('POST',`/v1/organizations/${business}/driver/shifts/${shift}/location-batches`,session),'proxy');
  assert.equal(driverGatewayDecision('POST',`/v1/organizations/${business}/driver/session/commands/sign-out`,session),'proxy');
  assert.equal(driverGatewayDecision('POST',`/v1/organizations/${business}/driver/session/commands/sign-out`),'deny');
  assert.equal(driverGatewayDecision('GET',`/v1/organizations/${business}/dispatch-board/2026-09-26`,session,business),'deny');
  assert.equal(driverGatewayDecision('POST',`/v1/organizations/${business}/fleet/drivers/commands/create`,session,business),'deny');
  assert.equal(driverGatewayDecision('GET','/v1/me','Synthetic principal_dispatcher',business),'deny');
  assert.equal(driverGatewayDecision('POST',`/v1/organizations/${business}/driver/action-batches`),'deny');
});
