import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {generateKeyPair,exportJWK,createLocalJWKSet,SignJWT} from 'jose';
import {withTenantTransaction} from '@kavaroutes/postgres-persistence';
import {createWp007Api,createWp007PostgresApplication} from '@kavaroutes/api-contracts';
import {createBusinessIdentity} from './business-identity.mjs';
import {createDriverSessions} from './driver-sessions.mjs';

/** Disposable PostgreSQL lane: exact subject admission, persisted cookie/CSRF,
 * immediate membership revocation, and the test-company-only Access exception. */
export async function checkBusinessIdentity(control,databaseUrl){
 const organizationA='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',organizationB='81000000-0000-4000-8000-000000000002';
 const issuer='https://identity-test.cloudflareaccess.com',businessIssuer='https://securetoken.google.com/kavaroutes',audience='a'.repeat(64),subject='verified-test-owner',businessSubject='business-owner';
 const {privateKey,publicKey}=await generateKeyPair('RS256'),keys=createLocalJWKSet({keys:[{...await exportJWK(publicKey),kid:'integration'}]});
 const token=await new SignJWT({email:'owner@example.test'}).setProtectedHeader({alg:'RS256',kid:'integration'}).setIssuer(issuer).setAudience(audience)
  .setSubject(subject).setIssuedAt().setExpirationTime('5m').sign(privateKey);
 const users=[];
 await withTenantTransaction(control,organizationB,'kavaroutes_migration',c=>c.query("INSERT INTO platform.organization(tenant_id,id,synthetic_name) VALUES($1,$1,'Business identity test') ON CONFLICT DO NOTHING",[organizationB]));
 for(const [organizationId,identityIssuer,identitySubject,owner] of [[organizationA,issuer,subject,true],[organizationB,issuer,subject,true],[organizationB,businessIssuer,businessSubject,false]]){
  const userId=randomUUID(),principalId=randomUUID();users.push({organizationId,userId,identityIssuer,identitySubject,principalId});
  await withTenantTransaction(control,organizationId,'kavaroutes_migration',async c=>{
   await c.query(`INSERT INTO platform.application_user(tenant_id,id,display_name,active) VALUES($1,$2,'Identity test',true)`,[organizationId,userId]);
   await c.query('INSERT INTO platform.identity_binding(tenant_id,user_id,issuer,subject,active) VALUES($1,$2,$3,$4,true)',[organizationId,userId,identityIssuer,identitySubject]);
   await c.query(`INSERT INTO platform.application_membership(tenant_id,user_id,principal_id,role,active) VALUES($1,$2,$3,'DISPATCHER',true)`,[organizationId,userId,principalId]);
   for(const kind of ['BRANCH','FLEET'])await c.query('INSERT INTO platform.membership_scope_grant(tenant_id,user_id,scope_kind,active) VALUES($1,$2,$3,true)',[organizationId,userId,kind]);
   if(owner)for(const capability of ['billing:read','billing:command','driver-policy:override'])await c.query('INSERT INTO platform.membership_capability_grant(tenant_id,user_id,capability,active) VALUES($1,$2,$3,true)',[organizationId,userId,capability]);
  });
 }
 const pool=new Pool({connectionString:databaseUrl,max:4}),driverSessions=createDriverSessions({credentialVersion:async()=>null});
 let providerActive=true;
 const identity=await createBusinessIdentity({pool,driverSessions,accessKeys:keys,
  config:{version:1,origin:'https://app.kavaroutes.com',signingKey:randomBytes(32).toString('base64url'),testAccess:{issuer,audience,organizationId:organizationA},firebase:null},
  provider:{verify:async token=>{if(token!=='verified-business-token')throw Error();return {issuer:businessIssuer,subject:businessSubject};},authorize:async()=>providerActive}});
 const app=await createWp007Api({verifier:identity.verifier,application:createWp007PostgresApplication(pool,{etagSecret:`synthetic-etag-secret-${randomBytes(32).toString('base64url')}`})});
 await identity.register(app);
 const headers={'cf-access-jwt-assertion':token,'x-kr-business-id':organizationA,'sec-fetch-site':'same-origin'};
 try{
  for(const persona of ['dispatcher','driver','billing','policy_override'])assert.equal((await app.inject({url:'/v1/me',headers:{...headers,authorization:`Synthetic principal_${persona}`}})).statusCode,401);
  const me=await app.inject({url:'/v1/me',headers});assert.equal(me.statusCode,200,me.body);assert.equal(me.json().principalKind,'BROWSER_USER');assert.equal(me.json().principalId,users[0].principalId);
  assert.equal(me.json().policyVersion,'privacy-v1');assert.ok(me.json().organizations[0].capabilities.includes('billing:read'));
  assert.equal((await app.inject({url:`/v1/organizations/${organizationB}/trips`,headers})).statusCode,401);
  assert.equal((await app.inject({url:'/v1/me',headers:{...headers,'x-kr-business-id':organizationB}})).statusCode,401);
  assert.equal((await app.inject({url:'/auth/workspace',headers:{'sec-fetch-site':'same-origin','cf-access-jwt-assertion':token}})).json().organizationId,organizationA);
  assert.equal((await app.inject({url:'/auth/workspace',headers:{'sec-fetch-site':'cross-site','cf-access-jwt-assertion':token}})).statusCode,401);
  const principal=await identity.verifier.verifyRequest({method:'GET',url:'/v1/realtime',headers:{...headers,origin:'https://app.kavaroutes.com'}});
  assert.equal(principal.id,users[0].principalId);
  assert.equal(await identity.revalidate({method:'GET',url:'/v1/realtime',headers:{...headers,origin:'https://app.kavaroutes.com'}},principal),true);
  await withTenantTransaction(control,organizationA,'kavaroutes_migration',c=>c.query('UPDATE platform.application_membership SET active=false WHERE tenant_id=$1 AND user_id=$2',[organizationA,users[0].userId]));
  assert.equal((await app.inject({url:'/v1/me',headers})).statusCode,401);
  assert.equal(await identity.revalidate({method:'GET',url:'/v1/realtime',headers},principal),false);
  const origin={origin:'https://app.kavaroutes.com','sec-fetch-site':'same-origin'};
  const challenge=await app.inject({method:'POST',url:'/auth/challenge',headers:origin,payload:{}});
  const loginHeaders={...origin,cookie:challenge.headers['set-cookie'].split(';')[0],'x-kr-csrf':challenge.json().csrf};
  assert.equal((await app.inject({method:'POST',url:'/auth/login',headers:loginHeaders,payload:{token:'verified-business-token',organizationId:organizationA}})).statusCode,401);
  const login=await app.inject({method:'POST',url:'/auth/login',headers:loginHeaders,payload:{token:'verified-business-token',organizationId:organizationB}});
  assert.equal(login.statusCode,200,login.body);
  const cookie=login.headers['set-cookie'][0].split(';')[0],sessionHeaders={'sec-fetch-site':'same-origin',cookie,'x-kr-business-id':organizationB};
  const own=await app.inject({url:'/v1/me',headers:sessionHeaders});assert.equal(own.statusCode,200,own.body);assert.equal(own.json().principalId,users[2].principalId);
  assert.equal(own.json().organizations[0].capabilities.includes('billing:read'),false);
  assert.equal((await app.inject({url:'/v1/me',headers:{...sessionHeaders,'x-kr-business-id':organizationA}})).statusCode,401);
  assert.equal((await app.inject({url:`/v1/organizations/${organizationA}/trips`,headers:{...sessionHeaders,'x-kr-business-id':organizationA}})).statusCode,401);
  assert.equal((await app.inject({method:'POST',url:`/v1/organizations/${organizationB}/trips`,headers:{...sessionHeaders,...origin,'idempotency-key':randomUUID()},payload:{}})).statusCode,401);
  assert.equal((await app.inject({url:'/auth/workspace',headers:sessionHeaders})).json().csrf,login.json().csrf);
  providerActive=false;assert.equal((await app.inject({url:'/v1/me',headers:sessionHeaders})).statusCode,401);
  providerActive=true;
  const out=await app.inject({method:'POST',url:'/auth/logout',headers:{...origin,cookie,'x-kr-csrf':login.json().csrf},payload:{}});assert.equal(out.statusCode,204);
  assert.equal((await app.inject({url:'/v1/me',headers:sessionHeaders})).statusCode,401);
 }finally{await app.close();await pool.end();}
}
