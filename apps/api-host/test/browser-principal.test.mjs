import assert from 'node:assert/strict';
import test from 'node:test';
import {randomBytes} from 'node:crypto';
import {createWp007Api} from '@kavaroutes/api-contracts';
import {createBrowserCredentials} from '../dist/browser-credentials.js';
import {createBrowserPrincipalVerifier,createBrowserRealtimeRevalidator} from '../dist/browser-principal.js';
import WebSocket from 'ws';
import {once} from 'node:events';
import {registerWp009Realtime} from '@kavaroutes/realtime/fastify';
import {createAuthorizationGenerationSource,createInMemoryRealtimeStore,createTestOnlyCursorCodec,REALTIME_PROTOCOL} from '@kavaroutes/realtime';
const origin='https://app.kavaroutes.com',organizationId='71000000-0000-4000-8000-000000000001';
function fixture(){
  const signingKey=randomBytes(32),credentials=createBrowserCredentials({origin,signingKey}),issued=credentials.issue(organizationId);
  let active=true,role='DISPATCHER',calls=0;
  const verifier=createBrowserPrincipalVerifier({origin,signingKey,resolve:async(org,token,csrf)=>{
    calls++;return active&&org===organizationId&&token===issued.tokenHash&&csrf===issued.csrfHash?{
      organizationId,principalId:'71000000-0000-4000-8000-000000000012',role,
      driverId:role==='DRIVER'?'71000000-0000-4000-8000-000000000010':null,
      authorizationGeneration:1,expiresAt:new Date(Date.now()+3600000).toISOString(),
    }:null;
  }});
  return {verifier,issued,headers:{cookie:issued.cookie.split(';')[0],'sec-fetch-site':'same-origin'},
    revoke:()=>{active=false;},driver:()=>{role='DRIVER';},calls:()=>calls};
}
test('actual API accepts browser cookie without synthetic headers and denies after revocation',async t=>{
  const f=fixture(),app=await createWp007Api({verifier:f.verifier});t.after(()=>app.close());
  const response=await app.inject({url:'/v1/me',headers:f.headers});
  assert.equal(response.statusCode,200,response.body);
  assert.equal(response.json().principalKind,'BROWSER_USER');
  assert.equal(response.json().organizations[0].organizationId,organizationId);
  const other='72000000-0000-4000-8000-000000000001';
  assert.equal((await app.inject({url:`/v1/organizations/${other}/trips`,headers:f.headers})).statusCode,404);
  assert.equal((await app.inject({url:'/v1/me',headers:{authorization:'Synthetic principal_dispatcher'}})).statusCode,401);
  assert.equal((await app.inject({url:'/v1/me',headers:{...f.headers,authorization:'Synthetic principal_dispatcher'}})).statusCode,401);
  f.revoke();assert.equal((await app.inject({url:'/v1/me',headers:f.headers})).statusCode,401);
});
test('unsafe requests require exact origin and CSRF; roles do not grant policy override',async()=>{
  const f=fixture();
  const req={method:'POST',headers:{...f.headers,origin}};
  assert.equal(await f.verifier.verifyRequest(req),null);
  assert.equal(f.calls(),0);
  const authorized=await f.verifier.verifyRequest({...req,headers:{...req.headers,'x-kr-csrf':f.issued.csrf}});
  assert.equal(authorized.kind,'BROWSER_USER');
  assert.equal(authorized.capabilities.has('dispatch:command'),true);
  assert.equal(authorized.capabilities.has('driver-policy:override'),false);
  assert.equal(authorized.capabilities.has('driver-policy:write'),false);
  assert.equal(await f.verifier.verifyRequest({...req,headers:{...req.headers,origin:'https://evil.example','x-kr-csrf':f.issued.csrf}}),null);
  f.driver();const driver=await f.verifier.verifyRequest({method:'GET',headers:f.headers});
  assert.equal(driver.capabilities.has('dispatch:command'),false);
  assert.equal(driver.subjectId,'71000000-0000-4000-8000-000000000010');
});
test('actual browser socket authenticates its cookie and closes after revocation',async t=>{
  const f=fixture(),app=await createWp007Api({verifier:f.verifier});let gateway;
  t.after(()=>app.close());
  await app.register(async scope=>{
    scope.decorateRequest('wp007Context');
    scope.addHook('onRequest',async(req,reply)=>{
      const principal=await f.verifier.verifyRequest({method:req.method,headers:req.headers});
      if(!principal)return reply.code(401).send({code:'AUTHENTICATION_REQUIRED'});
      req.wp007Context={principal};
    });
    gateway=await registerWp009Realtime(scope,{store:createInMemoryRealtimeStore(createTestOnlyCursorCodec()),
      generationSource:createAuthorizationGenerationSource(),allowedOrigins:new Set([origin]),
      revalidateBrowserSession:createBrowserRealtimeRevalidator(f.verifier)});
  });
  await app.listen({host:'127.0.0.1',port:0});
  const socket=new WebSocket(`ws://127.0.0.1:${app.server.address().port}/v1/realtime`,REALTIME_PROTOCOL,{headers:{...f.headers,origin}});
  t.after(()=>socket.terminate());
  const [ready]=await once(socket,'message');assert.equal(JSON.parse(ready).type,'connection.ready');
  f.revoke();const closed=once(socket,'close');await gateway.sessionSweep();
  const [code]=await closed;assert.equal(code,1008);assert.equal(gateway.activeConnections(),0);
});
