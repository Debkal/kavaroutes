import assert from 'node:assert/strict';
import test from 'node:test';
import {randomBytes} from 'node:crypto';
import Fastify from 'fastify';
import {registerBrowserAuth} from '../dist/browser-auth.js';
import {createIdentityAdmission} from '@kavaroutes/api-contracts/identity-admission';
const origin='https://app.kavaroutes.com',organizationId='71000000-0000-4000-8000-000000000001';

async function fixture(t,failResolve=false){
  const app=Fastify({logger:false}),rows=new Map();let admissions=0;
  const issuer='https://securetoken.google.com/kavaroutes';
  const admission=createIdentityAdmission({
    async verifyToken(token){admissions++;assert.equal(token,'verified-token');return{issuer,audience:'kavaroutes',subject:'subject',emailVerified:true,authenticatedAt:900,expiresAt:2000};},
    async findMembership(_issuer,_subject,org){return org===organizationId?{organizationId,
      userId:'71000000-0000-4000-8000-000000000020',principalId:'71000000-0000-4000-8000-000000000012',
      identityIssuer:issuer,identitySubject:'subject',userActive:true,membershipActive:true,authorizationGeneration:1}:null;},
  },{issuer,audience:'kavaroutes',now:()=>1000,maximumAuthenticationAgeSeconds:300});
  await registerBrowserAuth(app,{origin,signingKey:randomBytes(32),ports:{
    admit:admission.admit,
    async issue(input){rows.set(input.tokenHash,input);return{expiresAt:'2026-09-16T01:00:00.000Z'};},
    async resolve(org,hash,csrf){if(failResolve)throw new Error('DATABASE_SECRET_CANARY');const row=rows.get(hash);return row?.organizationId===org&&row.csrfHash===csrf?row:null;},
    async revoke(_org,hash){rows.delete(hash);},
  }});
  t.after(()=>app.close());
  const post=(url,headers={},payload)=>app.inject({method:'POST',url,headers:{origin,...headers},...(payload===undefined?{}:{payload})});
  return{app,rows,post,admissions:()=>admissions};
}
test('login exchanges provider token for hashed server session and logout revokes it',async t=>{
  const f=await fixture(t),challenge=await f.post('/auth/challenge');
  const login=await f.post('/auth/login',{cookie:challenge.headers['set-cookie'].split(';')[0],'x-kr-csrf':challenge.json().csrf},{organizationId,token:'verified-token'});
  assert.equal(login.statusCode,200,login.body);assert.equal(f.rows.size,1);
  assert.equal(login.headers['cache-control'],'no-store');
  assert.ok(!JSON.stringify([...f.rows.values()]).includes('verified-token'));
  const session=login.headers['set-cookie'][0].split(';')[0];
  const recovered=await f.post('/auth/session',{cookie:session});
  assert.equal(recovered.statusCode,200);
  assert.deepEqual(recovered.json(),{organizationId,csrf:login.json().csrf});
  assert.equal(recovered.headers['set-cookie'],undefined);
  assert.equal((await f.post('/auth/session',{cookie:session,origin:'https://evil.example'})).statusCode,403);
  assert.equal((await f.post('/auth/session')).statusCode,401);
  const bad=await f.post('/auth/logout',{cookie:session,'x-kr-csrf':'x'.repeat(43)});
  assert.equal(bad.statusCode,401);assert.equal(f.rows.size,1);
  const logout=await f.post('/auth/logout',{cookie:session,'x-kr-csrf':login.json().csrf});
  assert.equal(logout.statusCode,204);assert.equal(f.rows.size,0);
  const expired=await f.post('/auth/session',{cookie:session});
  assert.equal(expired.statusCode,401);assert.match(expired.headers['set-cookie'],/Max-Age=0/);
  assert.ok(logout.headers['set-cookie'][0].includes('Max-Age=0'));
});
test('database outage preserves cookie and yields retryable safe recovery failure',async t=>{
  const f=await fixture(t,true),challenge=await f.post('/auth/challenge');
  const login=await f.post('/auth/login',{cookie:challenge.headers['set-cookie'].split(';')[0],'x-kr-csrf':challenge.json().csrf},
    {organizationId,token:'verified-token'});
  const response=await f.post('/auth/session',{cookie:login.headers['set-cookie'][0].split(';')[0]});
  assert.equal(response.statusCode,503);assert.equal(response.headers['set-cookie'],undefined);
  assert.deepEqual(response.json(),{error:'SESSION_UNAVAILABLE'});
});
test('cross-site, absent challenge and client role escalation fail before admission',async t=>{
  const f=await fixture(t);
  assert.equal((await f.post('/auth/challenge',{origin:'https://evil.example'})).statusCode,403);
  assert.equal((await f.post('/auth/login',{}, {organizationId,token:'verified-token'})).statusCode,401);
  const challenge=await f.post('/auth/challenge');
  assert.equal((await f.post('/auth/login',{cookie:challenge.headers['set-cookie'].split(';')[0],'x-kr-csrf':challenge.json().csrf},
    {organizationId,token:'verified-token',role:'ADMIN'})).statusCode,401);
  assert.equal(f.admissions(),0);
});
test('login endpoints have a bounded global request budget and no-store errors',async t=>{
  const f=await fixture(t);
  for(let i=0;i<60;i++)assert.equal((await f.post('/auth/challenge')).statusCode,200);
  const limited=await f.post('/auth/challenge');
  assert.equal(limited.statusCode,429);assert.equal(limited.headers['cache-control'],'no-store');
});
