import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openStore} from '../src/store.mjs';
import {driverAccessLog,resetAllDriverAccess} from '../src/driver-access-log.mjs';
import {createDriverAccessStore} from '../../../infra/gcp/runtime/driver-access-store.mjs';
import {randomBytes} from 'node:crypto';

test('admin access log is filtered to the selected linked business',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'kr-access-admin-')),store=openStore(':memory:');
  const first='11111111-1111-4111-8111-111111111111',tenant='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',other='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  t.after(()=>{store.close();rmSync(directory,{recursive:true,force:true});});
  store.run("INSERT INTO businesses VALUES(?,?,?,'TRIAL','STARTER',1,?,?)",first,'test_pony','owner@example.com',Date.now(),Date.now());
  store.run('INSERT INTO business_workspaces(business_id,tenant_id) VALUES(?,?)',first,tenant);
  writeFileSync(join(directory,'access.json'),JSON.stringify({version:1,codes:[{businessId:tenant,hash:'private'}],devices:[],driverTokens:[],events:[
    {at:100,businessId:tenant,action:'ACCESS_CODE_RESET',actor:'owner',target:'code-1'},
    {at:200,businessId:other,action:'ACCESS_DEVICE_ENROLLED',actor:'other',target:'private-device'},
  ]}),{mode:0o640});
  const result=await driverAccessLog(store,first,{directory});
  assert.deepEqual(result.events,[{at:100,action:'ACCESS_CODE_RESET',actor:'owner',target:'code-1'}]);
  assert.ok(!JSON.stringify(result).includes('private'));
  await assert.rejects(driverAccessLog(store,other,{directory}),/BUSINESS_WORKSPACE_NOT_FOUND/);
});
test('owner reset rotates only the selected business and revokes its enrolled devices',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'kr-access-reset-')),store=openStore(':memory:');
  const first='11111111-1111-4111-8111-111111111111',second='22222222-2222-4222-8222-222222222222';
  const firstTenant='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',secondTenant='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  t.after(()=>{store.close();rmSync(directory,{recursive:true,force:true});});
  for(const [id,name,tenant] of [[first,'test_pony',firstTenant],[second,'second_business',secondTenant]]){
    store.run("INSERT INTO businesses VALUES(?,?,?,'TRIAL','STARTER',1,?,?)",id,name,'owner@example.com',Date.now(),Date.now());
    store.run('INSERT INTO business_workspaces(business_id,tenant_id) VALUES(?,?)',id,tenant);
  }
  writeFileSync(join(directory,'access.json'),JSON.stringify({version:1,codes:[],devices:[],driverTokens:[],events:[]}),{mode:0o640});
  const access=createDriverAccessStore(directory);
  const firstCode=await access.createCode(firstTenant,'SHARED','first'),secondCode=await access.createCode(secondTenant,'SHARED','second');
  const firstDevice=await access.enroll(firstCode.code,firstCode.password,'first phone');
  const secondDevice=await access.enroll(secondCode.code,secondCode.password,'second phone');
  const firstDriverToken=`dvs_${randomBytes(32).toString('base64url')}`;
  await access.bindDriverToken(firstTenant,firstDevice.device.id,firstDriverToken);
  assert.equal(await access.driverTokenAccess(firstDriverToken),true);
  assert.ok(await access.resolve(firstDevice.token));assert.ok(await access.resolve(secondDevice.token));
  await assert.rejects(resetAllDriverAccess(store,'33333333-3333-4333-8333-333333333333','owner@example.com',{directory}),/BUSINESS_WORKSPACE_NOT_FOUND/);
  const result=await resetAllDriverAccess(store,first,'owner@example.com',{directory});
  assert.equal(result.businessId,first);assert.equal(result.disabledCodeCount,1);assert.equal(result.signedOutDeviceCount,1);
  assert.match(result.code,/^business_[A-Za-z0-9_-]+$/);assert.ok(result.password.length>=32);
  assert.equal(await access.resolve(firstDevice.token),null);
  assert.equal(await access.driverTokenAccess(firstDriverToken),false);
  assert.ok(await access.resolve(secondDevice.token));
  assert.equal(await access.enroll(firstCode.code,firstCode.password,'old phone'),null);
  assert.ok(await access.enroll(result.code,result.password,'new phone'));
  const saved=readFileSync(join(directory,'access.json'),'utf8');
  assert.ok(!saved.includes(result.password));
  assert.equal((await driverAccessLog(store,first,{directory})).events.filter(row=>row.action==='ACCESS_CODES_RESET_ALL').length,1);
  assert.equal((await driverAccessLog(store,second,{directory})).events.some(row=>row.action==='ACCESS_CODES_RESET_ALL'),false);
  assert.equal(store.all("SELECT * FROM audit WHERE action='DRIVER_ACCESS_CODES_RESET_ALL'").length,1);
});
