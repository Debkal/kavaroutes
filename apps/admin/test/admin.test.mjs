import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { createLocalJWKSet, exportJWK, SignJWT } from 'jose';
import { openStore } from '../src/store.mjs';
import { createAdminServer } from '../src/server.mjs';
import { identityVerifier } from '../src/identity.mjs';
import { changeInvitedOwner } from '../src/change-owner.mjs';
import { inviteAdmin } from '../src/invite-admin.mjs';
import { base32, decrypt, digest, encrypt, publicKey, totp, verifySignature, verifyTotp } from '../src/crypto.mjs';
import { protectPrivateKey, signedResponse, unlockPrivateKey, validateChallenge } from '../bin/signer.mjs';

const owner='kavasupport@kavaroutes.com';
const keys=generateKeyPairSync('ml-dsa-65');
test('owner email replacement invalidates invitations and pending proofs, refuses active owners',()=>{
  const store=openStore(':memory:');
  try {
    store.run("INSERT INTO admins(email,role,state,invite_hash,invite_expiry) VALUES(?,'OWNER','INVITED',?,?)",'old@example.com',digest('old-token'),Date.now()+60000);
    store.run('INSERT INTO challenges VALUES(?,?,?,?,?,?,?)','test','old@example.com','browser','enroll','text',Date.now()+60000,1);
    changeInvitedOwner(store,'old@example.com',owner,'new-token');
    assert.equal(store.get('SELECT * FROM admins WHERE email=?','old@example.com'),undefined);
    const row=store.get('SELECT * FROM admins WHERE email=?',owner);
    assert.equal(row.invite_hash,digest('new-token'));assert.equal(row.generation,2);
    assert.equal(store.all('SELECT * FROM challenges').length,0);
    store.run("UPDATE admins SET state='ACTIVE' WHERE email=?",owner);
    assert.throws(()=>changeInvitedOwner(store,owner,'another@example.com','third-token'),/UNENROLLED_OWNER_REQUIRED/);
    assert.equal(store.get('SELECT email FROM admins').email,owner);
  } finally { store.close(); }
});
test('additional full admin preserves original owner and both receive owner permissions',async t=>{
  const f=await fixture(t),original=f.store.get('SELECT * FROM admins WHERE email=?',owner);
  inviteAdmin(f.store,'fciesinski1@gmail.com','OWNER','second-owner-invite');
  assert.deepEqual(f.store.get('SELECT * FROM admins WHERE email=?',owner),original);
  assert.throws(()=>inviteAdmin(f.store,owner,'OWNER','replacement'),/ACCOUNT_ALREADY_EXISTS/);
  const first=f.client(),second=f.client();
  await f.enroll(first);await f.enroll(second,'fciesinski1@gmail.com','second-owner-invite');
  for (const c of [first,second]) {
    const created=await c.post('business',{name:'Owner test business',contact:'office@example.com',plan:'STARTER',status:'TRIAL'});
    assert.equal(created.status,200);
    assert.equal((await c.post('dashboard')).body.admins.filter(a=>a.role==='OWNER'&&a.state==='ACTIVE').length,2);
  }
  assert.equal((await second.post('invite',{email:'new-support@example.com',role:'OWNER'})).status,200);
  assert.equal(f.store.get('SELECT role FROM admins WHERE email=?','new-support@example.com').role,'SUPPORT');
  assert.equal((await first.post('revoke',{email:'fciesinski1@gmail.com'})).status,400);
  const reopened=openStore(f.config.database);
  assert.equal(reopened.all("SELECT email FROM admins WHERE role='OWNER'").length,2);reopened.close();
});
async function fixture(t, opts={}) {
  const directory=mkdtempSync(join(tmpdir(),'kr-admin-test-'));
  const config={mode:'local',port:0,origin:'',database:join(directory,'admin.sqlite'),encryptionKey:randomBytes(32)};
  const store=openStore(config.database);
  store.run("INSERT INTO admins(email,role,state,invite_hash,invite_expiry) VALUES(?,'OWNER','INVITED',?,?)",owner,digest('test-invite'),Date.now()+60000);
  const server=createAdminServer({config,store,...opts});
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  config.origin=`http://127.0.0.1:${server.address().port}`;
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));store.close();rmSync(directory,{recursive:true,force:true});});
  const client=()=>{
    const jar={};let csrf='';
    return {
      jar,
      async post(path,data={},extra={}) {
        const response=await fetch(`${config.origin}/api/${path}`,{method:'POST',headers:{origin:config.origin,'content-type':'application/json','x-admin-csrf':csrf,cookie:Object.entries(jar).map(([k,v])=>`${k}=${v}`).join('; '),...extra},body:JSON.stringify(data)});
        for(const cookie of response.headers.getSetCookie()){const first=cookie.split(';')[0],i=first.indexOf('=');jar[first.slice(0,i)]=first.slice(i+1);}
        const body=await response.json();if(body.csrf)csrf=body.csrf;
        return {status:response.status,body,headers:response.headers};
      },
    };
  };
  async function enroll(c,email=owner,invite='test-invite',pair=keys) {
    const challenge=await c.post('challenge',{email,invite});assert.equal(challenge.status,200);
    const proof=await c.post('prove',{response:signedResponse(pair.privateKey,challenge.body.challenge)});assert.equal(proof.status,200);
    assert.match(proof.body.qr,/^data:image\/png;base64,/);
    const pending=store.get('SELECT * FROM enrollments WHERE email=?',email),secret=decrypt(pending.secret,config.encryptionKey,email);
    const result=await c.post('enroll',{enrollment:proof.body.enrollment,code:totp(secret)});assert.equal(result.status,200);
    return secret;
  }
  return {config,store,server,client,enroll};
}

test('TOTP matches all RFC 6238 SHA-1 vectors and rejects reuse',()=>{
  const secret=Buffer.from('12345678901234567890');
  for(const [seconds,expected] of [[59,'94287082'],[1111111109,'07081804'],[1111111111,'14050471'],[1234567890,'89005924'],[2000000000,'69279037'],[20000000000,'65353130']])assert.equal(totp(secret,seconds*1000,8),expected);
  assert.equal(base32(Buffer.from('foobar')),'MZXW6YTBOI');
  assert.equal(verifyTotp(secret,totp(secret,59000),-1,59000),1);
  assert.equal(verifyTotp(secret,totp(secret,59000),1,59000),null);
  assert.equal(verifyTotp(secret,'12345',-1,59000),null);
});
test('ML-DSA-65 proof and encrypted key roundtrip; wrong key/passphrase/tampering rejected',()=>{
  const text='challenge',response=signedResponse(keys.privateKey,text);
  assert.equal(verifySignature(response.publicKey,text,response.signature),true);
  assert.equal(verifySignature(response.publicKey,text+'x',response.signature),false);
  const envelope=protectPrivateKey(keys.privateKey,'correct horse battery staple');
  const unlocked=unlockPrivateKey(envelope,'correct horse battery staple');
  assert.equal(verifySignature(response.publicKey,text,signedResponse(unlocked,text).signature),true);
  assert.throws(()=>unlockPrivateKey(envelope,'not the right password'));
  assert.throws(()=>protectPrivateKey(keys.privateKey,'short'));
  const ed=generateKeyPairSync('ed25519').publicKey.export({type:'spki',format:'pem'});
  assert.throws(()=>publicKey(ed));
  const key=randomBytes(32),encrypted=encrypt(Buffer.from('totp-secret'),key,owner);
  assert.equal(decrypt(encrypted,key,owner).toString(),'totp-secret');
  assert.throws(()=>decrypt(encrypted,key,'other@example.com'));
});
test('signer refuses wrong origin/account, expired and excessive-lifetime challenges',()=>{
  const now=Date.now(),value={protocol:'KavaRoutes admin authentication v1',algorithm:'ML-DSA-65',origin:'https://admin.kavaroutes.com',email:owner,purpose:'login',id:'00000000-0000-4000-8000-000000000000',nonce:'a'.repeat(43),expires:now+60000};
  assert.equal(validateChallenge(JSON.stringify(value),value.origin,owner,now).email,owner);
  assert.equal(validateChallenge(JSON.stringify({...value,expires:now+600000}),value.origin,owner,now).email,owner);
  for(const changes of [{origin:'https://evil.example'},{email:'attacker@example.com'},{expires:now-1},{expires:now+660000},{purpose:'transfer'},{extra:true}])assert.throws(()=>validateChallenge(JSON.stringify({...value,...changes}),value.origin,owner,now));
});
test('owner enrollment creates persistent business records; optimistic edits, CSRF and audit enforced',async t=>{
  const f=await fixture(t),c=f.client();await f.enroll(c);
  assert.equal((await c.post('business',{name:'Test NEMT',contact:'contact@example.com',status:'TRIAL',plan:'STARTER'},{'x-admin-csrf':''})).status,403);
  const create=await c.post('business',{name:'Test NEMT',contact:'contact@example.com',status:'TRIAL',plan:'STARTER'});assert.equal(create.status,200);
  const dashboard=await c.post('dashboard');assert.equal(dashboard.body.businesses.length,1);
  const item=dashboard.body.businesses[0];assert.equal(item.name,'Test NEMT');
  assert.equal((await c.post('business',{...item,status:'ACTIVE'})).status,200);
  assert.equal((await c.post('business',{...item,status:'SUSPENDED'})).status,409);
  assert.ok((await c.post('dashboard')).body.audit.some(x=>x.action==='TEST_BUSINESS_UPDATED'));
  const reopened=openStore(f.config.database);assert.equal(reopened.get('SELECT status FROM businesses WHERE id=?',item.id).status,'ACTIVE');reopened.close();
  assert.equal((await c.post('session')).status,200);
  assert.equal((await c.post('logout')).status,200);assert.equal((await c.post('dashboard')).status,401);
});
test('challenge requires invite, browser binding, signature and TOTP; proof replay rejected',async t=>{
  const f=await fixture(t),c=f.client();
  assert.equal((await c.post('challenge',{email:owner,invite:'wrong'})).status,401);
  const challenge=await c.post('challenge',{email:owner,invite:'test-invite'});
  const response=signedResponse(keys.privateKey,challenge.body.challenge);
  assert.equal((await f.client().post('prove',{response})).status,401);
  const proof=await c.post('prove',{response});assert.equal(proof.status,200);
  assert.equal((await c.post('prove',{response})).status,401);
  assert.equal((await c.post('dashboard')).status,401);
  assert.equal((await c.post('enroll',{enrollment:proof.body.enrollment,code:'wrong'})).status,401);
  const pending=f.store.get('SELECT * FROM enrollments WHERE email=?',owner),secret=decrypt(pending.secret,f.config.encryptionKey,owner);
  assert.equal((await c.post('enroll',{enrollment:proof.body.enrollment,code:totp(secret)})).status,200);
  assert.equal((await c.post('enroll',{enrollment:proof.body.enrollment,code:totp(secret)})).status,401);
});
test('login consumes proof on wrong code, rejects reused TOTP and wrong signing key',async t=>{
  const f=await fixture(t),c=f.client(),secret=await f.enroll(c);await c.post('logout');
  let challenge=await c.post('challenge',{email:owner});
  let response=signedResponse(keys.privateKey,challenge.body.challenge);
  assert.equal((await c.post('prove',{response,code:'invalid'})).status,401);
  assert.equal((await c.post('prove',{response,code:totp(secret)})).status,401);
  challenge=await c.post('challenge',{email:owner});response=signedResponse(keys.privateKey,challenge.body.challenge);
  const previous=f.store.get('SELECT last_totp FROM admins WHERE email=?',owner).last_totp;
  assert.equal((await c.post('prove',{response,code:totp(secret,previous*30000)})).status,401);
  challenge=await c.post('challenge',{email:owner});response=signedResponse(generateKeyPairSync('ml-dsa-65').privateKey,challenge.body.challenge);
  assert.equal((await c.post('prove',{response,code:totp(secret)})).status,401);
  // Simulate a later authenticator interval without waiting or changing the clock.
  f.store.run('UPDATE admins SET last_totp=-1 WHERE email=?',owner);
  challenge=await c.post('challenge',{email:owner});response=signedResponse(keys.privateKey,challenge.body.challenge);
  assert.equal((await c.post('prove',{response,code:totp(secret)})).status,200);
});
test('support has read-only access and revocation immediately invalidates sessions',async t=>{
  const f=await fixture(t),c=f.client();await f.enroll(c);
  const invitation=await c.post('invite',{email:'support@example.com'});assert.equal(invitation.status,200);
  const support=f.client();await f.enroll(support,'support@example.com',invitation.body.invite,generateKeyPairSync('ml-dsa-65'));
  assert.equal((await support.post('dashboard')).status,200);
  assert.equal((await support.post('accounting',{month:'2026-09'})).status,200);
  assert.equal((await support.post('customer-mail')).status,200);
  for(const path of ['business','invite','revoke','subscription','invoice','invoice-status','expense','expense-void','usage','customer-contact','email-template','email-preview','email-queue','email-cancel','email-rule'])assert.equal((await support.post(path,{})).status,403);
  assert.equal((await c.post('revoke',{email:owner})).status,400);
  assert.equal((await c.post('revoke',{email:'support@example.com'})).status,200);
  assert.equal((await support.post('dashboard')).status,401);
  assert.equal((await support.post('session')).status,401);
});
test('rejects cross-origin requests, DNS rebinding hosts, expired challenges, oversized JSON and rate bursts',async t=>{
  const f=await fixture(t),c=f.client();
  assert.equal((await c.post('challenge',{email:owner,invite:'test-invite'},{origin:'https://evil.example'})).status,403);
  const hostStatus=await new Promise((resolve,reject)=>{
    const req=request(`${f.config.origin}/api/config`,{method:'POST',headers:{host:'evil.example',origin:f.config.origin,'content-type':'application/json'}},res=>{res.resume();resolve(res.statusCode);});
    req.on('error',reject);req.end('{}');
  });
  assert.equal(hostStatus,403);
  assert.equal((await c.post('config',{large:'x'.repeat(25000)})).status,413);
  const challenge=await c.post('challenge',{email:owner,invite:'test-invite'});
  f.store.run('UPDATE challenges SET expires=0');
  assert.equal((await c.post('prove',{response:signedResponse(keys.privateKey,challenge.body.challenge)})).status,401);
  let last;for(let i=0;i<13;i++)last=await c.post('challenge',{email:owner,invite:'test-invite'});
  assert.equal(last.status,429);
});
test('Cloudflare mode rejects absent/incorrect identity and enforces identity on session reuse',async t=>{
  let accepted=true;
  const f=await fixture(t,{verifyIdentity:async(_request,email)=>{if(!accepted)throw new Error();return {email,subject:'verified-provider-subject'};}}),c=f.client();
  await f.enroll(c);accepted=false;
  assert.equal((await c.post('session')).status,401);
  assert.equal((await c.post('dashboard')).status,401);
});
test('real JWT verification checks Cloudflare signature, issuer, audience, expiry and required identity claims',async()=>{
  const {privateKey,publicKey}=generateKeyPairSync('rsa',{modulusLength:2048});
  const jwk=await exportJWK(publicKey);jwk.kid='test';
  const config={mode:'cloudflare',accessIssuer:'https://example.cloudflareaccess.com',accessAudience:'a'.repeat(64)};
  const verifier=identityVerifier(config,{jwks:createLocalJWKSet({keys:[jwk]})});
  async function jwt(changes={}) {return new SignJWT({email:owner,sub:'subject',...changes}).setProtectedHeader({alg:'RS256',kid:'test'}).setIssuer(changes.iss??config.accessIssuer).setAudience(changes.aud??config.accessAudience).setIssuedAt().setExpirationTime(changes.exp??'5m').sign(privateKey);}
  const request=token=>({headers:{'cf-access-jwt-assertion':token}});
  assert.equal((await verifier(request(await jwt()))).email,owner);
  for(const changes of [{iss:'https://evil.example'},{aud:'wrong'},{exp:1},{sub:''},{email:null}])await assert.rejects(()=>jwt(changes).then(token=>verifier(request(token))));
  await assert.rejects(()=>verifier({headers:{}}));
  const token=await jwt();await assert.rejects(()=>verifier(request(token.slice(0,-10)+'aaaaaaaaaa')));
});
