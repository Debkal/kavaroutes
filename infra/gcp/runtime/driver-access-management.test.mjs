import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import Fastify from 'fastify';
import {registerDriverAccessManagement} from './driver-access-management.mjs';

const business='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const other='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
test('Command access management is tenant scoped and records code actions',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'kr-access-manage-'));
  await writeFile(join(directory,'access.json'),JSON.stringify({version:1,codes:[],devices:[],driverTokens:[],events:[],driverTokens:[]}));
  const app=Fastify();
  const principal={id:'dispatcher-test',kind:'SYNTHETIC_USER',organizationId:business,capabilities:new Set(['dispatch:command']),purposes:new Set(['ASSIGNED_SERVICE_DELIVERY'])};
  registerDriverAccessManagement(app,{directory,verify:async authorization=>authorization==='Synthetic principal_dispatcher'?principal:null});
  const path=id=>`/v1/organizations/${id}/driver-access`;
  const headers={authorization:'Synthetic principal_dispatcher',origin:'https://app.kavaroutes.com','content-type':'application/json'};
  try{
    assert.equal((await app.inject({method:'GET',url:path(business)})).statusCode,404);
    assert.equal((await app.inject({method:'GET',url:path(other),headers})).statusCode,404);
    const made=await app.inject({method:'POST',url:`${path(business)}/codes`,headers,payload:{kind:'ONE_DEVICE',label:'Joel phone'}});
    assert.equal(made.statusCode,200,made.body);
    assert.match(made.json().code,/^dev_[A-Za-z0-9_-]{11}$/);
    assert.match(made.json().password,/^[A-Za-z0-9_-]{16}$/);
    const listed=await app.inject({method:'GET',url:path(business),headers});
    assert.equal(listed.statusCode,200);
    assert.equal(listed.json().codes[0].label,'Joel phone');
    assert.ok(!listed.body.includes(made.json().password));
    assert.equal(listed.json().events[0].action,'ACCESS_CODE_CREATED');
    const defaultSetting=await app.inject({method:'GET',url:`${path(business)}/inspection-settings`,headers});
    assert.deepEqual(defaultSetting.json(),{precheckDefault:'NO_ISSUE'});
    assert.equal((await app.inject({method:'POST',url:`${path(other)}/inspection-settings`,headers,payload:{precheckDefault:'MANUAL'}})).statusCode,404);
    assert.equal((await app.inject({method:'POST',url:`${path(business)}/inspection-settings`,headers,payload:{precheckDefault:'INVALID'}})).statusCode,400);
    const changed=await app.inject({method:'POST',url:`${path(business)}/inspection-settings`,headers,payload:{precheckDefault:'MANUAL'}});
    assert.deepEqual(changed.json(),{precheckDefault:'MANUAL'});
    assert.deepEqual((await app.inject({method:'GET',url:`${path(business)}/inspection-settings`,headers})).json(),{precheckDefault:'MANUAL'});
    const reset=await app.inject({method:'POST',url:`${path(business)}/codes/${made.json().id}/reset`,headers,payload:{}});
    assert.equal(reset.statusCode,200);
    assert.notEqual(reset.json().password,made.json().password);
    assert.equal((await app.inject({method:'POST',url:`${path(other)}/codes/${made.json().id}/reset`,headers,payload:{}})).statusCode,404);
  }finally{await app.close();await rm(directory,{recursive:true,force:true});}
});
