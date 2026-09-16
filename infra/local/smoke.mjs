import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {chromium} from '@playwright/test';
import http from 'node:http';
if(process.env.KAVAROUTES_LOCAL_VERIFY!=='1')throw new Error('LOCAL_COMPOSE_OPT_IN_REQUIRED');
const origin=`http://127.0.0.1:${process.env.KAVAROUTES_PORT??8080}`,prefix='/v1/organizations/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const auth={authorization:'Synthetic principal_dispatcher'},path='.tooling/local-compose-smoke.json';
await mkdir('.tooling',{recursive:true});let saved;
try{saved=JSON.parse(await readFile(path,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
if(saved)assert.equal((await fetch(origin+prefix+'/trips/'+saved.tripId,{headers:auth})).status,200,'previous trip must survive restart before any replay writes');
if(!saved){saved={tripId:randomUUID(),key:'compose-'+randomUUID()};await writeFile(path,JSON.stringify(saved),{mode:0o600});}
const body={tripId:saved.tripId,riderId:'11111111-1111-4111-8111-111111111112',serviceDate:'2026-09-15',serviceTimezone:'America/Los_Angeles',localServiceTime:'08:00:00',resolvedServiceAt:'2026-09-15T15:00:00.000Z',resolvedUtcOffsetSeconds:-25200,ambiguityPolicy:'reject'};
const response=await fetch(origin+prefix+'/trips',{method:'POST',headers:{...auth,'content-type':'application/json','idempotency-key':saved.key},body:JSON.stringify(body)});
assert.equal(response.status,201);assert.equal((await response.json()).tripId,saved.tripId);
assert.equal((await fetch(origin+prefix+'/trips/'+saved.tripId,{headers:auth})).status,200);
assert.equal((await fetch(origin+'/v1/me')).status,401);
assert.equal((await fetch(origin+'/v1/me',{headers:{...auth,origin:'https://untrusted.example'}})).status,403);
// Fetch normalizes Host; use raw HTTP to actually send the rebinding header.
const badHost=await new Promise((resolve,reject)=>{
 const request=http.get(origin+'/v1/me',{headers:{...auth,host:'untrusted.example:8080'}},response=>{response.resume();resolve(response.statusCode);});
 request.on('error',reject);request.setTimeout(3000,()=>request.destroy(new Error('HOST_CHECK_TIMEOUT')));
});
assert.equal(badHost,403);
const browser=await chromium.launch({headless:true});
try{
 const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
 const sockets=[];page.on('websocket',s=>sockets.push(s.url()));
 await page.goto(origin+'/dispatch');await page.getByRole('heading',{name:'Cloud trip workspace',exact:true}).waitFor();
 await page.getByText('Cloud updates: live',{exact:true}).waitFor();
 await page.getByRole('region',{name:'Cloud dispatch board'}).getByLabel('Service date',{exact:true}).fill('2026-09-15');
 await page.getByRole('button',{name:'View run 1',exact:true}).waitFor();
 await page.getByRole('link',{name:/Facility/}).click();await page.getByRole('heading',{name:'Facility arrivals',exact:true}).waitFor();
 await page.getByRole('button',{name:'View trip 1',exact:true}).waitFor();await page.reload();await page.getByRole('button',{name:'View trip 1',exact:true}).waitFor();
 assert.equal(errors.length,0);assert.ok(sockets.length);assert.ok(sockets.every(s=>s===origin.replace('http:','ws:')+'/v1/realtime'));
 console.log('LOCAL_COMPOSE_REST_PERSISTENCE_WEBSOCKET_DISPATCH_FACILITY_VERIFIED');
}finally{await browser.close();}
