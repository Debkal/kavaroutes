import test from 'node:test';
import assert from 'node:assert/strict';
import {createDriverSessions} from './driver-sessions.mjs';

const organizationId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const driverId='44444444-4444-4444-8444-444444444444';
const otherDriverId='55555555-5555-4555-8555-555555555555';
const synthetic={verify:async header=>header==='Synthetic principal_driver'?{subjectId:'prototype',kind:'SYNTHETIC_DEVICE'}:null};

test('driver sessions bind API authority to the claimed driver and expire on credential change',async()=>{
  let version=2,clock=0;
  const sessions=createDriverSessions({synthetic,now:()=>clock,credentialVersion:async(_organization,reference)=>
    reference===driverId?{status:'ACTIVE',version}:null});
  const token=sessions.issue(organizationId,{driverId,status:'ACTIVE',version});
  assert.match(token,/^dvs_[A-Za-z0-9_-]{43}$/);
  const principal=await sessions.verify(`DriverSession ${token}`);
  assert.equal(principal.subjectId,driverId);
  assert.equal(principal.kind,'SYNTHETIC_DEVICE');
  assert.equal(principal.capabilities.has('driver:execute'),true);
  assert.equal(principal.capabilities.has('dispatch:command'),false);
  assert.equal(await sessions.verify(`DriverSession ${token}x`),null);
  assert.equal(await sessions.verify(`DriverSession dvs_${'x'.repeat(43)}`),null);
  version=3;
  assert.equal(await sessions.verify(`DriverSession ${token}`),null);
  const other=sessions.issue(organizationId,{driverId:otherDriverId,status:'ACTIVE',version:3});
  assert.equal(await sessions.verify(`DriverSession ${other}`),null);
  assert.equal(await sessions.verify('Synthetic principal_driver'),null);
  clock=12*60*60*1000+1;
  assert.equal(await sessions.verify(`DriverSession ${token}`),null);
});
