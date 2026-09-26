import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {createServer} from 'node:http';
import {createDriverBusinessGate} from './driver-business-gate.mjs';
import {createDriverAccessStore} from './driver-access-store.mjs';

const business='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const other='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
test('business gate enrolls and revokes devices without exposing the password',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'kr-driver-gate-'));
  const old=join(dir,'admin.json'),registry=join(dir,'registry');
  const password='separate-business-access-secret';
  await writeFile(old,JSON.stringify({accounts:[]}));
  const provision=pass=>spawnSync('python3',[new URL('./provision-driver-access.py',import.meta.url).pathname,old,business,'test_pony'],{input:pass,encoding:'utf8'});
  assert.equal(provision(password).status,0);
  const migrated=spawnSync('python3',[new URL('./migrate-driver-access.py',import.meta.url).pathname,old,registry],{encoding:'utf8'});
  assert.equal(migrated.status,0,migrated.stderr);
  const store=createDriverAccessStore(registry);
  const gate=createDriverBusinessGate({storeDirectory:registry});
  const server=createServer(async(request,response)=>{
    try{
      const url=new URL(request.url,'https://driver.kavaroutes.com');
      if(await gate.handle(request,response,url))return;
      const account=await gate.account(request);
      response.writeHead(account?200:404).end(account?.businessId??'');
    }catch(error){response.writeHead(500).end(String(error));}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const url=`http://127.0.0.1:${server.address().port}`;
  const post=async(code,pass,next='/driver')=>{
    const form=await fetch(`${url}/business-access`);
    const nonce=/name="nonce" value="([A-Za-z0-9_-]+)"/.exec(await form.text())?.[1];assert.ok(nonce);
    return fetch(`${url}/business-access`,{method:'POST',redirect:'manual',headers:{origin:'null','content-type':'application/x-www-form-urlencoded',cookie:`__Host-kr_driver_form=${nonce}`},body:new URLSearchParams({code,password:pass,next,nonce})});
  };
  try{
    assert.equal((await fetch(`${url}/business-access`)).status,200);
    assert.equal((await fetch(`${url}/driver`)).status,404);
    assert.equal((await post('test_pony','wrong-password-here')).status,401);
    assert.equal((await post('other',password)).status,401);
    const signed=await post('test_pony',password,`/driver?businessId=${other}&driverId=11111111-1111-4111-8111-111111111111`);
    assert.equal(signed.status,303);
    assert.equal(signed.headers.get('location'),`/driver?businessId=${business}`);
    const cookie=signed.headers.get('set-cookie');assert.match(cookie,/__Host-kr_driver_business=/);
    assert.match(cookie,/HttpOnly; Secure; SameSite=Strict/);assert.match(cookie,/Max-Age=2592000/);
    assert.equal((await fetch(`${url}/driver`,{headers:{cookie}})).status,200);
    const recreated=createDriverBusinessGate({storeDirectory:registry});
    assert.equal((await recreated.account({headers:{cookie}})).businessId,business);
    const deviceId=(await recreated.account({headers:{cookie}})).deviceId;
    const driverToken=`dvs_${'a'.repeat(43)}`;
    await recreated.bindDriverToken(business,deviceId,driverToken);
    assert.equal(await recreated.driverTokenAccess(driverToken),true);
    const before=await store.list(business);
    assert.equal(before.devices.length,1);
    assert.ok(!(await readFile(join(registry,'access.json'),'utf8')).includes(password));
    await store.signOutDevice(business,before.devices[0].id);
    assert.equal((await fetch(`${url}/driver`,{headers:{cookie}})).status,404);
    assert.equal(await recreated.driverTokenAccess(driverToken),false);
    const unique=await store.createCode(business,'ONE_DEVICE','Joel phone');
    assert.equal((await post(unique.code,unique.password)).status,303);
    assert.equal((await post(unique.code,unique.password)).status,401);
    const shared=before.codes[0];
    await store.resetCode(business,shared.id);
    assert.equal((await post('test_pony',password)).status,401);
    assert.ok((await store.list(business)).events.some(event=>event.action==='ACCESS_CODE_RESET'));
  }finally{await new Promise(resolve=>server.close(resolve));await rm(dir,{recursive:true,force:true});}
});
