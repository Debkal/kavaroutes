import test from 'node:test';
import assert from 'node:assert/strict';
import {createSiteApp,admitBusinessIdentity} from '../server/app.mjs';
import {openStore} from '../server/store.mjs';
import {readConfig} from '../server/config.mjs';

const origin='https://kavaroutes.com',tenantId='business-tenant';
const claim=(extra={})=>({uid:'business-owner-1',email_verified:true,auth_time:Math.floor(Date.now()/1000),
  firebase:{tenant:tenantId,sign_in_provider:'password'},...extra});
async function fixture(t,claims=claim()){
  const store=openStore(':memory:');let disabled=false,revoked=false;
  const config={...readConfig(),origin,local:false,authEnabled:true,firebase:{projectId:'kavaroutes',authDomain:'kavaroutes.firebaseapp.com',tenantId}};
  const app=createSiteApp({config,store,identity:{verify:async token=>{if(token!=='valid-token')throw new Error('token rejected');return claims;},
    account:async()=>({email:'owner@example.com',emailVerified:true,disabled,tokensValidAfterTime:revoked?new Date(Date.now()+1000).toISOString():null})}});
  t.after(async()=>{await app.close();store.close();});
  return {app,store,disable:()=>{disabled=true;},revoke:()=>{revoked=true;},
    post:(url,payload,extra={})=>app.inject({method:'POST',url,headers:{origin,'content-type':'application/json',...extra},payload}),
    login:()=>app.inject({method:'POST',url:'/api/session',headers:{origin,'content-type':'application/json'},payload:{token:'valid-token',businessName:'Calm Transit'}})};
}
test('only verified identities in the business tenant with supported sign-in methods are admitted',()=>{
  for(const provider of ['password','google.com','microsoft.com'])assert.equal(admitBusinessIdentity(claim({firebase:{tenant:tenantId,sign_in_provider:provider}}),tenantId),'business-owner-1');
  for(const change of [{email_verified:false},{role:'DRIVER'},{accountType:'driver'},
    {firebase:{sign_in_provider:'password'}},{firebase:{tenant:'driver-tenant',sign_in_provider:'google.com'}},
    {firebase:{tenant:tenantId,sign_in_provider:'custom'}},{auth_time:Math.floor(Date.now()/1000)-301}])assert.throws(()=>admitBusinessIdentity(claim(change),tenantId));
});
test('verified signup persists a pending business and creates a secure, revocable session',async t=>{
  const f=await fixture(t),login=await f.login();assert.equal(login.statusCode,200,login.body);
  const setCookie=login.headers['set-cookie'];assert.match(setCookie,/__Host-kr_business_session=/);assert.match(setCookie,/HttpOnly/);assert.match(setCookie,/Secure/);assert.match(setCookie,/SameSite=Strict/);assert.doesNotMatch(setCookie,/valid-token/);
  const cookie=setCookie.split(';')[0];
  const account=await f.app.inject({url:'/api/account',headers:{cookie}});
  assert.equal(account.statusCode,200);assert.deepEqual(account.json(),{businessName:'Calm Transit',email:'owner@example.com',subscription:'PENDING',checkoutEnabled:false,softwareAccess:false});
  assert.equal((await f.post('/api/checkout',{}, {cookie})).statusCode,503);
  assert.equal((await f.app.inject({url:'/api/software',headers:{cookie}})).statusCode,403);
  assert.equal((await f.post('/api/logout',{}, {cookie})).statusCode,204);
  assert.equal((await f.app.inject({url:'/api/account',headers:{cookie}})).statusCode,401);
});
test('cross-origin login and logout, forged roles, invalid tokens, and anonymous access are refused',async t=>{
  const f=await fixture(t);
  assert.equal((await f.post('/api/session',{token:'valid-token',businessName:'Transit'},{origin:'https://evil.example'})).statusCode,403);
  assert.equal((await f.post('/api/session',{token:'valid-token',businessName:'Transit',role:'OWNER'})).statusCode,400);
  assert.equal((await f.post('/api/session',{token:'driver_password',businessName:'Transit'})).statusCode,401);
  assert.equal((await f.post('/api/logout',{}, {origin:'https://evil.example'})).statusCode,403);
  assert.equal((await f.app.inject({url:'/api/account'})).statusCode,401);
  assert.equal((await f.app.inject({url:'/api/software'})).statusCode,401);
  assert.equal((await f.post('/api/checkout',{})).statusCode,401);
});
test('driver sign-in cannot enroll a business or mint a cookie',async t=>{
  const f=await fixture(t,claim({role:'DRIVER'})),response=await f.login();
  assert.equal(response.statusCode,403);assert.equal(response.headers['set-cookie'],undefined);assert.equal(f.store.get('business-owner-1'),undefined);
});
test('provider disablement and revocation are checked on every account request',async t=>{
  for(const method of ['disable','revoke']){
    const f=await fixture(t),cookie=(await f.login()).headers['set-cookie'].split(';')[0];f[method]();
    assert.equal((await f.app.inject({url:'/api/account',headers:{cookie}})).statusCode,401);
  }
});
test('sign-in cannot overwrite a business name or accept a browser subscription status',async t=>{
  const f=await fixture(t);await f.login();
  assert.equal((await f.post('/api/session',{token:'valid-token',businessName:'Overwrite'})).statusCode,200);
  assert.equal(f.store.get('business-owner-1').businessName,'Calm Transit');
  assert.equal((await f.post('/api/session',{token:'valid-token',subscription:'ACTIVE'})).statusCode,400);
});
test('missing authentication configuration fails closed without a driver or demo fallback',async t=>{
  const config=readConfig({});assert.equal(config.authEnabled,false);
  const store=openStore(':memory:'),app=createSiteApp({config,store,identity:null});
  t.after(async()=>{await app.close();store.close();});
  const response=await app.inject({method:'POST',url:'/api/session',headers:{origin:config.origin,'content-type':'application/json'},payload:{token:'anything'}});
  assert.equal(response.statusCode,503);assert.equal((await app.inject({url:'/api/config'})).json().firebase,null);
  assert.equal((await app.inject({url:'/v1/organizations/anything/trips'})).statusCode,404);
});
