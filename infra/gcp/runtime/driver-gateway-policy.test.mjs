import test from 'node:test';
import assert from 'node:assert/strict';
import {driverGatewayDecision} from './driver-gateway-policy.mjs';

const business='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const driver='11111111-1111-4111-8111-111111111111';
const shift='22222222-2222-4222-8222-222222222222';
const session=`DriverSession dvs_${'a'.repeat(43)}`;
const admin=`DriverAdmin ${'a'.repeat(43)}`;

test('public Driver host exposes only driver login and authorized driver work',()=>{
  assert.equal(driverGatewayDecision('GET','/driver'),'static');
  assert.equal(driverGatewayDecision('GET','/driver-admin'),'static');
  assert.equal(driverGatewayDecision('POST',`/v1/organizations/${business}/driver-logins/commands/verify`),'proxy');
  assert.equal(driverGatewayDecision('POST',`/v1/organizations/${business}/driver-logins/${driver}/commands/claim`),'proxy');
  assert.equal(driverGatewayDecision('GET',`/v1/organizations/${business}/driver/itineraries/2026-09-26`,session),'proxy');
  assert.equal(driverGatewayDecision('POST',`/v1/organizations/${business}/driver/shifts/${shift}/location-batches`,session),'proxy');
  assert.equal(driverGatewayDecision('GET',`/v1/organizations/${business}/dispatch-board/2026-09-26`,session),'deny');
  assert.equal(driverGatewayDecision('POST',`/v1/organizations/${business}/fleet/drivers/commands/create`,session),'deny');
  assert.equal(driverGatewayDecision('GET','/v1/me','Synthetic principal_dispatcher'),'deny');
  assert.equal(driverGatewayDecision('POST',`/v1/organizations/${business}/driver/action-batches`),'deny');
  assert.equal(driverGatewayDecision('POST','/driver-admin/drivers',admin),'proxy');
  assert.equal(driverGatewayDecision('POST','/driver-admin/drivers',session),'deny');
});
