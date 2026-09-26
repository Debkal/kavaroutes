import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openStore} from '../src/store.mjs';
import {driverAccessLog} from '../src/driver-access-log.mjs';

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
