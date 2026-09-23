import test from 'node:test';
import assert from 'node:assert/strict';
import {createWp007Api,ProtocolError,strongEtag,syntheticIds} from '../dist/index.js';

test('public driver credential exchange needs no prototype identity and grants no itinerary access by itself',async()=>{
  const driverId='44444444-4444-4444-8444-444444444444';
  const state={driverId,loginId:'joel',status:'ACTIVE',claimedAt:'2026-09-23T19:00:00.000Z',lastLoginAt:null,version:2};
  const app=await createWp007Api({publicDriverLogin:true,
    driverLoginService:{claim:async()=>state,verify:async()=>state},
    issueDriverSession:()=>`dvs_${'c'.repeat(43)}`});
  try{
    const root=`/v1/organizations/${syntheticIds.organizationA}`;
    const claim=await app.inject({method:'POST',url:`${root}/driver-logins/${driverId}/commands/claim`,
      headers:{'idempotency-key':'public-driver-claim-20260923'},payload:{driverId,inviteCode:'test-invite-code',password:'test-password'}});
    assert.equal(claim.statusCode,200,claim.body);
    assert.match(claim.json().sessionToken,/^dvs_/);
    const verify=await app.inject({method:'POST',url:`${root}/driver-logins/commands/verify`,
      headers:{'idempotency-key':'public-driver-verify-20260923'},payload:{loginId:'joel',password:'test-password'}});
    assert.equal(verify.statusCode,200,verify.body);
    assert.equal((await app.inject({url:`${root}/driver/itineraries/2026-09-24`})).statusCode,401);
    assert.equal((await app.inject({method:'POST',url:`${root}/fleet/drivers/commands/create`,
      headers:{'idempotency-key':'public-driver-create-denied-20260923'},payload:{displayName:'Nope',loginId:'nope',workforceRelationship:'EMPLOYEE'}})).statusCode,401);
  }finally{await app.close();}
});

test('real driver session reaches shift start and trip actions as its own subject',async()=>{
  const driverId='44444444-4444-4444-8444-444444444444',token=`dvs_${'b'.repeat(43)}`;
  const principal={id:driverId,kind:'SYNTHETIC_DEVICE',organizationId:syntheticIds.organizationA,subjectId:driverId,
    capabilities:new Set(['driver:execute','driver:manifest:read','driver:location:write']),purposes:new Set(['ASSIGNED_SERVICE_DELIVERY']),
    branchScopes:new Set(),fleetScopes:new Set()};
  const reached=[];
  const fail=input=>{reached.push(input.principal.subjectId);throw new ProtocolError(409,'DRIVER_SERVICE_REACHED','test');};
  const app=await createWp007Api({verifier:{verify:async header=>header===`DriverSession ${token}`?principal:null},
    issueDriverSession:()=>token,driverShiftService:{start:fail},driverActionService:{submit:fail}});
  try{
    const headers={authorization:`DriverSession ${token}`,'idempotency-key':'driver-real-session-20260923'};
    const started=await app.inject({method:'POST',url:`/v1/organizations/${syntheticIds.organizationA}/driver/shifts/commands/start`,headers,
      payload:{assignmentId:'40000000-0000-4000-8000-000000000001',serviceDate:'2026-09-24',expectedAssignmentVersion:1,loginId:'joel'}});
    assert.equal(started.statusCode,409,started.body);
    assert.equal(started.json().code,'DRIVER_SERVICE_REACHED');
    const actions=await app.inject({method:'POST',url:`/v1/organizations/${syntheticIds.organizationA}/driver/action-batches`,headers:{...headers,'idempotency-key':'driver-real-action-20260923'},
      payload:{deviceSessionId:'55555555-5555-4555-8555-555555555555',shiftReference:'66666666-6666-4666-8666-666666666666',
        shiftGeneration:'77777777-7777-4777-8777-777777777777',items:[{clientActionId:'88888888-8888-4888-8888-888888888888',deviceEpoch:1,sequence:1,
          capturedAt:'2026-09-23T20:00:00.000Z',resourceReference:'99999999-9999-4999-8999-999999999999',expectedTag:strongEtag('secret','99999999-9999-4999-8999-999999999999',1,'driver'),
          idempotencyKey:'driver-real-item-20260923',command:'MARK_EN_ROUTE'}]}});
    assert.equal(actions.statusCode,409,actions.body);
    assert.equal(actions.json().code,'DRIVER_SERVICE_REACHED');
    assert.deepEqual(reached,[driverId,driverId]);
  }finally{await app.close();}
});
