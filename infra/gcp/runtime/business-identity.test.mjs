import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {generateKeyPair,exportJWK,createLocalJWKSet,SignJWT} from 'jose';
import {createAccessIdentityVerifier,validateBusinessIdentityConfig} from './business-identity.mjs';
import {createDriverSessions} from './driver-sessions.mjs';
const issuer='https://identity-test.cloudflareaccess.com',audience='a'.repeat(64);
const config={version:1,origin:'https://app.kavaroutes.com',signingKey:randomBytes(32).toString('base64url'),
 testAccess:{issuer,audience,organizationId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'},firebase:null};

test('business configuration separates a test-only Access gate from ordinary account sign-in',()=>{
 assert.equal(validateBusinessIdentityConfig(config).testAccess.organizationId,config.testAccess.organizationId);
 for(const value of [{...config,signingKey:'weak'},{...config,origin:'http://app.kavaroutes.com'},
  {...config,testAccess:{...config.testAccess,audience:'unknown'}},{...config,testAccess:null},
  {...config,synthetic:true},{...config,firebase:{projectId:'kavaroutes'}}])assert.throws(()=>validateBusinessIdentityConfig(value));
});
test('Access identities require signature, exact issuer/audience, expiry and a user subject',async()=>{
 const {privateKey,publicKey}=await generateKeyPair('RS256'),jwk={...await exportJWK(publicKey),kid:'identity-key'};
 const verify=createAccessIdentityVerifier({issuer,audience},createLocalJWKSet({keys:[jwk]}));
 const token=async claims=>new SignJWT({email:'owner@example.test',...claims}).setProtectedHeader({alg:'RS256',kid:jwk.kid})
  .setIssuer(claims?.iss??issuer).setAudience(claims?.aud??audience).setSubject(claims?.sub??'verified-owner')
  .setIssuedAt().setExpirationTime(claims?.exp??'5m').sign(privateKey);
 assert.deepEqual(await verify({'cf-access-jwt-assertion':await token()}),{issuer,subject:'verified-owner'});
 for(const claims of [{aud:'b'.repeat(64)},{iss:'https://wrong.cloudflareaccess.com'},{exp:1},{sub:''},{email:null}])
  assert.equal(await verify({'cf-access-jwt-assertion':await token(claims)}),null);
 assert.equal(await verify({'cf-access-authenticated-user-email':'owner@example.test'}),null);
 assert.equal(await verify({'cf-access-jwt-assertion':(await token()).slice(0,-6)+'broken'}),null);
});
test('live driver sessions never fall back to any legacy persona',async()=>{
 let calls=0;
 const sessions=createDriverSessions({synthetic:{verify:async()=>{calls++;return {kind:'SYNTHETIC_USER'};}},credentialVersion:async()=>null});
 for(const persona of ['dispatcher','driver','billing','policy_override','facility'])assert.equal(await sessions.verify(`Synthetic principal_${persona}`),null);
 assert.equal(calls,5);
 const explicitTest=createDriverSessions({synthetic:{verify:async()=>({kind:'SYNTHETIC_USER'})},allowSyntheticDriver:true,credentialVersion:async()=>null});
 assert.equal((await explicitTest.verify('Synthetic principal_dispatcher')).kind,'SYNTHETIC_USER');
});

test('provider account requests are pooled, bounded and refreshed without keeping failed results',async()=>{
 const {createPooledAccountLookup}=await import('./business-identity.mjs');
 let clock=0,calls=0,fail=false;
 const read=createPooledAccountLookup(async subject=>{calls++;if(fail)throw Error('provider down');return {subject};},{now:()=>clock,ttlMs:30,maximum:2});
 const first=await Promise.all([read('owner'),read('owner'),read('owner')]);
 assert.equal(calls,1);assert.deepEqual(first,[{subject:'owner'},{subject:'owner'},{subject:'owner'}]);
 await read('owner');assert.equal(calls,1);
 clock=31;await read('owner');assert.equal(calls,2);
 await read('second');await read('third');await read('owner');assert.equal(calls,5);
 clock=70;fail=true;await assert.rejects(read('owner'));fail=false;await read('owner');assert.equal(calls,7);
 const deadline=createPooledAccountLookup(()=>new Promise(()=>{}),{maximum:1,deadlineMs:5});
 const pending=deadline('one');await assert.rejects(deadline('two'),/CAPACITY/);await assert.rejects(pending,/TIMEOUT/);
});
