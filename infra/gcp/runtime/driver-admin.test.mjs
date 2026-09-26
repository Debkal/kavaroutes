import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import Fastify from 'fastify';
import {registerDriverAdmin} from './driver-admin.mjs';

test('business driver admin creates accounts only in its own tenant',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'kr-driver-admin-'));
  const file=join(dir,'accounts.json');
  const businessId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const password='a-private-driver-admin-password';
  await writeFile(file,JSON.stringify({accounts:[]}));
  const provision=spawnSync('python3',[new URL('./provision-driver-admin.py',import.meta.url).pathname,file,businessId,'test_pony_admin'],{input:password,encoding:'utf8'});
  assert.equal(provision.status,0,provision.stderr);
  const calls=[];const app=Fastify();
  registerDriverAdmin(app,{accountsFile:file,driverLogins:{createAccount:async input=>{calls.push(input);return {body:{driverId:'11111111-1111-4111-8111-111111111111',inviteCode:'private-code',loginId:input.request.loginId}};}}});
  const post=(url,payload,headers={})=>app.inject({method:'POST',url,headers:{origin:'https://driver.kavaroutes.com','x-kr-driver-business-id':businessId,'content-type':'application/json',...headers},payload});
  try{
    const wrong=await post('/driver-admin/session',{loginId:'test_pony_admin',password:'wrong-password-here'});
    assert.equal(wrong.statusCode,401);
    const signed=await post('/driver-admin/session',{loginId:'test_pony_admin',password});
    assert.equal(signed.statusCode,200);
    assert.equal(signed.json().businessId,businessId);
    const wrongBusiness=await post('/driver-admin/session',{loginId:'test_pony_admin',password},{'x-kr-driver-business-id':'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'});
    assert.equal(wrongBusiness.statusCode,401);
    const denied=await post('/driver-admin/drivers',{displayName:'Joel',loginId:'joeldriver',workforceRelationship:'EMPLOYEE'},
      {'idempotency-key':`driver-admin-${'a'.repeat(36)}`});
    assert.equal(denied.statusCode,401);
    const created=await post('/driver-admin/drivers',{displayName:'Joel',loginId:'joeldriver',workforceRelationship:'EMPLOYEE'},
      {authorization:`DriverAdmin ${signed.json().token}`,'idempotency-key':`driver-admin-${'a'.repeat(36)}`});
    assert.equal(created.statusCode,201);
    assert.equal(calls.length,1);
    assert.equal(calls[0].organizationId,businessId);
    assert.equal(calls[0].principal.organizationId,businessId);
    assert.deepEqual([...calls[0].principal.capabilities],['dispatch:command']);
    const loggedOut=await post('/driver-admin/logout',{}, {authorization:`DriverAdmin ${signed.json().token}`});
    assert.equal(loggedOut.statusCode,204);
    const revoked=await post('/driver-admin/drivers',{displayName:'Other',loginId:'otherdriver',workforceRelationship:'EMPLOYEE'},
      {authorization:`DriverAdmin ${signed.json().token}`,'idempotency-key':`driver-admin-${'b'.repeat(36)}`});
    assert.equal(revoked.statusCode,401);
  }finally{await app.close();await rm(dir,{recursive:true,force:true});}
});
