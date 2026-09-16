import assert from 'node:assert/strict';
import { createIdentityMembershipReader, createApplicationSessionStore, withTenantTransaction } from '@kavaroutes/postgres-persistence';
import { createIdentityAdmission } from '../../../packages/api-contracts/dist/identity-admission.js';
import { createBrowserCredentials } from '../../../apps/api-host/dist/browser-credentials.js';
import { randomBytes } from 'node:crypto';
import Fastify from 'fastify';
import { registerPostgresBrowserAuth } from '../../../apps/api-host/dist/postgres-browser-auth.js';
import {createBrowserPrincipalVerifier} from '../../../apps/api-host/dist/browser-principal.js';
import {createWp007Api} from '@kavaroutes/api-contracts';
import {companyBranchScope,companyFleetScope} from '../../../packages/api-contracts/dist/security.js';
import {authorizeRealtimeSubscription} from '../../../packages/realtime/dist/authorization.js';

export async function checkIdentityMembership(pool) {
  const tenant = '71000000-0000-4000-8000-000000000001';
  const other = '72000000-0000-4000-8000-000000000001';
  const user = '71000000-0000-4000-8000-000000000020';
  const principal = '71000000-0000-4000-8000-000000000012';
  const issuer = 'https://securetoken.google.com/kavaroutes';
  await withTenantTransaction(pool, tenant, 'kavaroutes_migration', async c => {
    await c.query("INSERT INTO platform.organization(tenant_id,id,synthetic_name) VALUES($1,$1,'Pony identity test')", [tenant]);
    await c.query("INSERT INTO platform.application_user(tenant_id,id,display_name,active) VALUES($1,$2,'PonyDispatch',true)", [tenant,user]);
    await c.query("INSERT INTO platform.identity_binding(tenant_id,user_id,issuer,subject,active) VALUES($1,$2,$3,'verified-subject',true)", [tenant,user,issuer]);
    await c.query("INSERT INTO platform.application_membership(tenant_id,user_id,principal_id,active,role) VALUES($1,$2,$3,true,'DISPATCHER')", [tenant,user,principal]);
  });
  const read = createIdentityMembershipReader(pool);
  assert.equal((await read(issuer, 'verified-subject', tenant)).principalId, principal);
  assert.equal(await read(issuer, 'verified-subject', other), null);
  assert.equal(await read(issuer, 'unknown-subject', tenant), null);
  assert.equal(await read('https://wrong.example', 'verified-subject', tenant), null);
  await withTenantTransaction(pool, other, 'kavaroutes_api', async c => {
    for (const table of ['application_user','identity_binding','application_membership']) {
      assert.equal((await c.query(`SELECT * FROM platform.${table}`)).rowCount, 0);
    }
  });
  await assert.rejects(withTenantTransaction(pool, tenant, 'kavaroutes_api', c =>
    c.query('UPDATE platform.application_membership SET active=false WHERE tenant_id=$1', [tenant])));
  const admit = createIdentityAdmission({ findMembership: read, verifyToken: async () => ({ issuer, audience: 'kavaroutes',
    subject: 'verified-subject', emailVerified: true, authenticatedAt: 900, expiresAt: 2000 }) },
  { issuer, audience: 'kavaroutes', now: () => 1000, maximumAuthenticationAgeSeconds: 300 });
  assert.equal((await admit.admit('test-token',tenant)).userId,user);
  const sessions=createApplicationSessionStore(pool);
  const authApp=Fastify({logger:false});
  try {
    await registerPostgresBrowserAuth(authApp,{origin:'https://app.kavaroutes.com',signingKey:randomBytes(32),pool},
      async()=>({issuer,audience:'kavaroutes',subject:'verified-subject',emailVerified:true,
        authenticatedAt:Math.floor(Date.now()/1000),expiresAt:Math.floor(Date.now()/1000)+3600}));
    const post=(url,headers={},payload)=>authApp.inject({method:'POST',url,
      headers:{origin:'https://app.kavaroutes.com',...headers},...(payload===undefined?{}:{payload})});
    const challenge=await post('/auth/challenge');
    const challengeHeaders={cookie:challenge.headers['set-cookie'].split(';')[0],'x-kr-csrf':challenge.json().csrf};
    const denied=await post('/auth/login',challengeHeaders,{token:'test-token',organizationId:other});
    assert.equal(denied.statusCode,401);
    const login=await post('/auth/login',challengeHeaders,{token:'test-token',organizationId:tenant});
    assert.equal(login.statusCode,200,login.body);
    const cookie=login.headers['set-cookie'][0].split(';')[0];
    const resumed=await post('/auth/session',{cookie});
    assert.equal(resumed.statusCode,200);
    assert.equal(resumed.json().csrf,login.json().csrf);
    assert.equal(resumed.headers['set-cookie'],undefined);
    assert.equal((await post('/auth/logout',{cookie,'x-kr-csrf':'x'.repeat(43)})).statusCode,401);
    const logout=await post('/auth/logout',{cookie,'x-kr-csrf':login.json().csrf});
    assert.equal(logout.statusCode,204);
    assert.equal((await post('/auth/session',{cookie})).statusCode,401);
    assert.equal((await post('/auth/logout',{cookie,'x-kr-csrf':login.json().csrf})).statusCode,401);
  } finally {await authApp.close();}
  const browser=createBrowserCredentials({origin:'https://app.kavaroutes.com',signingKey:randomBytes(32)});
  const challenge=browser.challenge();
  browser.assertSameOrigin({origin:'https://app.kavaroutes.com'});
  browser.verifyChallenge(challenge.cookie.split(';')[0],challenge.csrf);
  const browserIssued=browser.issue(tenant);
  await sessions.issue({organizationId:tenant,userId:user,principalId:principal,issuer,subject:'verified-subject',
    authorizationGeneration:1,tokenHash:browserIssued.tokenHash,csrfHash:browserIssued.csrfHash});
  const received=browser.read(browserIssued.cookie.split(';')[0],browserIssued.csrf);
  assert.equal((await sessions.resolve(received.organizationId,received.tokenHash,received.csrfHash)).principalId,principal);
  const wrongCsrf=browser.read(browserIssued.cookie.split(';')[0],browser.issue(tenant).csrf);
  assert.equal(await sessions.resolve(wrongCsrf.organizationId,wrongCsrf.tokenHash,wrongCsrf.csrfHash),null);
  // Real request authentication against the database, without mounting auth on
  // the retained synthetic server. This app exists only inside this test.
  const requestKey=randomBytes(32),requestCredentials=createBrowserCredentials({origin:'https://app.kavaroutes.com',signingKey:requestKey});
  const requestIssued=requestCredentials.issue(tenant);
  await sessions.issue({organizationId:tenant,userId:user,principalId:principal,issuer,subject:'verified-subject',authorizationGeneration:1,
    tokenHash:requestIssued.tokenHash,csrfHash:requestIssued.csrfHash});
  const requestApi=await createWp007Api({verifier:createBrowserPrincipalVerifier({origin:'https://app.kavaroutes.com',signingKey:requestKey,resolve:sessions.resolve})});
  try{
    const headers={cookie:requestIssued.cookie.split(';')[0],'sec-fetch-site':'same-origin'};
    const profile=await requestApi.inject({url:'/v1/me',headers});
    assert.equal(profile.statusCode,200,profile.body);assert.equal(profile.json().principalKind,'BROWSER_USER');
    assert.equal(profile.json().organizations[0].organizationId,tenant);
    assert.equal((await requestApi.inject({url:`/v1/organizations/${other}/trips`,headers})).statusCode,404);
    await sessions.revoke(tenant,requestIssued.tokenHash);
    assert.equal((await requestApi.inject({url:'/v1/me',headers})).statusCode,401);
  }finally{await requestApi.close();}
  await sessions.revoke(received.organizationId,received.tokenHash);
  assert.equal(await sessions.resolve(received.organizationId,received.tokenHash),null);
  const credential={organizationId:tenant,userId:user,principalId:principal,issuer,subject:'verified-subject',
    authorizationGeneration:1,tokenHash:'a'.repeat(64),csrfHash:'b'.repeat(64)};
  await sessions.issue(credential);
  assert.equal((await sessions.resolve(tenant,credential.tokenHash,credential.csrfHash)).role,'DISPATCHER');
  assert.equal(await sessions.resolve(other,credential.tokenHash),null);
  assert.equal(await sessions.resolve(tenant,'c'.repeat(64)),null);
  assert.equal(await sessions.resolve(tenant,credential.tokenHash,'c'.repeat(64)),null);
  await assert.rejects(sessions.issue({...credential,tokenHash:'d'.repeat(64),authorizationGeneration:99}),/ADMISSION_DENIED/);
  await assert.rejects(sessions.issue({...credential,tokenHash:'d'.repeat(64),subject:'wrong-subject'}),/ADMISSION_DENIED/);
  await withTenantTransaction(pool,other,'kavaroutes_api',async c => {
    assert.equal((await c.query('SELECT * FROM platform.application_session')).rowCount,0);
  });
  await assert.rejects(withTenantTransaction(pool,tenant,'kavaroutes_api',c =>
    c.query('UPDATE platform.application_session SET authorization_generation=99 WHERE tenant_id=$1',[tenant])));
  await sessions.revoke(tenant,credential.tokenHash);
  await sessions.revoke(tenant,credential.tokenHash);
  assert.equal(await sessions.resolve(tenant,credential.tokenHash),null);
  const activeToken='d'.repeat(64);
  await sessions.issue({...credential,tokenHash:activeToken});
  await withTenantTransaction(pool, tenant, 'kavaroutes_migration', c =>
    c.query('UPDATE platform.application_membership SET active=false,authorization_generation=2 WHERE tenant_id=$1', [tenant]));
  await assert.rejects(admit.admit('test-token',tenant), /SIGN_IN_NOT_AUTHORIZED/);
  assert.equal(await sessions.resolve(tenant,activeToken),null);
  await withTenantTransaction(pool,tenant,'kavaroutes_migration',c =>
    c.query('UPDATE platform.application_membership SET active=true WHERE tenant_id=$1',[tenant]));
  assert.equal(await sessions.resolve(tenant,activeToken),null,'reactivation cannot revive an old session');
  const refreshed=await read(issuer,'verified-subject',tenant);
  assert.equal(refreshed.authorizationGeneration,3);
  await assert.rejects(sessions.issue({...credential,tokenHash:'e'.repeat(64)}),/ADMISSION_DENIED/);
  await sessions.issue({...credential,authorizationGeneration:3,tokenHash:'e'.repeat(64)});
  await withTenantTransaction(pool, tenant, 'kavaroutes_migration', c =>
    c.query('UPDATE platform.identity_binding SET active=false WHERE tenant_id=$1', [tenant]));
  assert.equal(await read(issuer,'verified-subject',tenant),null);
  assert.equal(await sessions.resolve(tenant,'e'.repeat(64)),null);
  await withTenantTransaction(pool,tenant,'kavaroutes_migration',c =>
    c.query('UPDATE platform.identity_binding SET active=true WHERE tenant_id=$1',[tenant]));
  assert.equal(await sessions.resolve(tenant,'e'.repeat(64)),null,'binding reactivation cannot revive sessions');
  const latest=await read(issuer,'verified-subject',tenant);
  await sessions.issue({...credential,authorizationGeneration:latest.authorizationGeneration,tokenHash:'f'.repeat(64)});
  await withTenantTransaction(pool,tenant,'kavaroutes_migration',c => c.query(`UPDATE platform.application_session
    SET created_at=statement_timestamp()-interval '2 hours',expires_at=statement_timestamp()-interval '1 hour'
    WHERE token_hash=$1`,['f'.repeat(64)]));
  assert.equal(await sessions.resolve(tenant,'f'.repeat(64)),null);
  await sessions.issue({...credential,authorizationGeneration:latest.authorizationGeneration,tokenHash:'1'.repeat(64)});
  const reopened=createApplicationSessionStore(pool);
  assert.equal((await reopened.resolve(tenant,'1'.repeat(64))).principalId,principal);
  await withTenantTransaction(pool,tenant,'kavaroutes_migration',c =>
    c.query('UPDATE platform.application_user SET active=false WHERE tenant_id=$1 AND id=$2',[tenant,user]));
  assert.equal(await reopened.resolve(tenant,'1'.repeat(64)),null);
  await withTenantTransaction(pool,tenant,'kavaroutes_migration',c =>
    c.query('UPDATE platform.application_user SET active=true WHERE tenant_id=$1 AND id=$2',[tenant,user]));
  assert.equal(await reopened.resolve(tenant,'1'.repeat(64)),null,'user reactivation cannot revive sessions');

  // ---- CQ-002: explicit company-scoped grants, elevated capability grants and
  // multi-company isolation on real PostgreSQL.
  const companyB = '72000000-0000-4000-8000-000000000002';
  const userB = '72000000-0000-4000-8000-000000000021';
  const principalB = '72000000-0000-4000-8000-000000000013';
  const subjectB = 'verified-subject-b';
  const grantedSubject = 'granted-subject';
  const branchScope = companyBranchScope(tenant), fleetScope = companyFleetScope(tenant);
  const generationOf = async organizationId => Number((await withTenantTransaction(pool, organizationId, 'kavaroutes_api',
    c => c.query('SELECT authorization_generation FROM platform.application_membership WHERE tenant_id=$1', [organizationId]))).rows[0].authorization_generation);
  await withTenantTransaction(pool, companyB, 'kavaroutes_migration', async c => {
    await c.query("INSERT INTO platform.organization(tenant_id,id,synthetic_name) VALUES($1,$1,'Pony second company')", [companyB]);
    await c.query("INSERT INTO platform.application_user(tenant_id,id,display_name,active) VALUES($1,$2,'PonyDispatch second',true)", [companyB, userB]);
    await c.query('INSERT INTO platform.identity_binding(tenant_id,user_id,issuer,subject,active) VALUES($1,$2,$3,$4,true)', [companyB, userB, issuer, subjectB]);
    await c.query("INSERT INTO platform.application_membership(tenant_id,user_id,principal_id,active,role) VALUES($1,$2,$3,true,'DISPATCHER')", [companyB, userB, principalB]);
    for (const kind of ['BRANCH','FLEET']) await c.query('INSERT INTO platform.membership_scope_grant(tenant_id,user_id,scope_kind,active) VALUES($1,$2,$3,true)', [companyB, userB, kind]);
  });
  // Both companies are real tenants with the same role shape; only the grant rows differ.
  const authorityKey = randomBytes(32);
  const authorityCreds = createBrowserCredentials({origin:'https://app.kavaroutes.com',signingKey:authorityKey});
  const authorityVerifier = createBrowserPrincipalVerifier({origin:'https://app.kavaroutes.com',signingKey:authorityKey,resolve:sessions.resolve});
  const authorityApi = await createWp007Api({verifier:authorityVerifier});
  const sessionFor = async (organizationId, userId, principalId, subject) => {
    const issued = authorityCreds.issue(organizationId);
    await sessions.issue({organizationId, userId, principalId, issuer, subject,
      authorizationGeneration: await generationOf(organizationId), tokenHash: issued.tokenHash, csrfHash: issued.csrfHash});
    return {headers:{cookie:issued.cookie.split(';')[0],'sec-fetch-site':'same-origin'}, tokenHash:issued.tokenHash};
  };
  const principalFor = headers => authorityVerifier.verifyRequest({method:'GET',headers});
  try {
    // Company A holds no grants yet: role defaults still work, scoped authority does not.
    await withTenantTransaction(pool, tenant, 'kavaroutes_migration', c =>
      c.query('UPDATE platform.identity_binding SET subject=$2 WHERE tenant_id=$1 AND user_id=$3', [tenant, grantedSubject, user]));
    const ungranted = await sessionFor(tenant, user, principal, grantedSubject);
    assert.equal((await authorityApi.inject({url:'/v1/me', headers:ungranted.headers})).statusCode, 200);
    assert.equal((await authorityApi.inject({url:`/v1/organizations/${tenant}/dispatch-board/2026-09-16`, headers:ungranted.headers})).statusCode, 404,
      'no branch grant means the scoped board is hidden');
    const ungrantedPrincipal = await principalFor(ungranted.headers);
    assert.equal(ungrantedPrincipal.branchScopes.size, 0);
    assert.equal(ungrantedPrincipal.fleetScopes.size, 0);
    assert.equal(ungrantedPrincipal.capabilities.has('driver-policy:override'), false, 'override is never implied by a role');
    const ungrantedGeneration = await generationOf(tenant);
    assert.throws(() => authorizeRealtimeSubscription({principal:ungrantedPrincipal, organizationId:tenant,
      authorizationGeneration:ungrantedGeneration, purpose:'DISPATCH_CONTROL',
      scope:{streamKind:'DISPATCH_DAY',scopeReference:branchScope,serviceDate:'2026-09-16'}}), /REALTIME_AUTHORIZATION_DENIED/);
    // The API role can read grants and can never write them.
    await assert.rejects(withTenantTransaction(pool, tenant, 'kavaroutes_api', c =>
      c.query('UPDATE platform.membership_scope_grant SET active=true WHERE tenant_id=$1', [tenant])));
    await assert.rejects(withTenantTransaction(pool, tenant, 'kavaroutes_api', c =>
      c.query("INSERT INTO platform.membership_capability_grant(tenant_id,user_id,capability,active) VALUES($1,$2,'audit:read',true)", [tenant, user])));
    // Administrator provisioning grants exactly the two company scopes.
    await withTenantTransaction(pool, tenant, 'kavaroutes_migration', async c => {
      for (const kind of ['BRANCH','FLEET']) await c.query('INSERT INTO platform.membership_scope_grant(tenant_id,user_id,scope_kind,active) VALUES($1,$2,$3,true)', [tenant, user, kind]);
    });
    assert.equal(await sessions.resolve(tenant, ungranted.tokenHash), null, 'a grant change invalidates live sessions');
    const granted = await sessionFor(tenant, user, principal, grantedSubject);
    const grantedPrincipal = await principalFor(granted.headers);
    assert.deepEqual([...grantedPrincipal.branchScopes], [branchScope]);
    assert.deepEqual([...grantedPrincipal.fleetScopes], [fleetScope]);
    const board = await authorityApi.inject({url:`/v1/organizations/${tenant}/dispatch-board/2026-09-16`, headers:granted.headers});
    assert.equal(board.statusCode, 503, 'authorized scoped request reaches the unpromoted runtime path');
    assert.equal((await authorityApi.inject({url:`/v1/organizations/${companyB}/dispatch-board/2026-09-16`, headers:granted.headers})).statusCode, 404,
      'another company stays hidden');
    const grantedGeneration = await generationOf(tenant);
    assert.equal(authorizeRealtimeSubscription({principal:grantedPrincipal, organizationId:tenant,
      authorizationGeneration:grantedGeneration, purpose:'DISPATCH_CONTROL',
      scope:{streamKind:'DISPATCH_DAY',scopeReference:branchScope,serviceDate:'2026-09-16'}}).purpose, 'DISPATCH_CONTROL');
    assert.equal(authorizeRealtimeSubscription({principal:grantedPrincipal, organizationId:tenant,
      authorizationGeneration:grantedGeneration, purpose:'DISPATCH_CURRENT_POSITION',
      scope:{streamKind:'CURRENT_POSITION',scopeReference:fleetScope}}).purpose, 'DISPATCH_CURRENT_POSITION');
    assert.throws(() => authorizeRealtimeSubscription({principal:grantedPrincipal, organizationId:tenant,
      authorizationGeneration:grantedGeneration, purpose:'DISPATCH_CONTROL',
      scope:{streamKind:'DISPATCH_DAY',scopeReference:companyBranchScope(companyB),serviceDate:'2026-09-16'}}), /REALTIME_AUTHORIZATION_DENIED/);
    // Elevated capability requires its own grant, and it also bumps the generation.
    assert.equal(grantedPrincipal.capabilities.has('driver-policy:override'), false);
    await withTenantTransaction(pool, tenant, 'kavaroutes_migration', c =>
      c.query("INSERT INTO platform.membership_capability_grant(tenant_id,user_id,capability,active) VALUES($1,$2,'driver-policy:override',true)", [tenant, user]));
    assert.equal(await sessions.resolve(tenant, granted.tokenHash), null, 'capability grant changes invalidate live sessions');
    const elevatedSession = await sessionFor(tenant, user, principal, grantedSubject);
    const elevated = await principalFor(elevatedSession.headers);
    assert.equal(elevated.capabilities.has('driver-policy:override'), true);
    assert.equal(elevated.capabilities.has('audit:read'), false);
    // Company B resolves only against its own membership and grants; company A's
    // grants are invisible to it (forced RLS on both grant tables).
    const companyBSession = await sessionFor(companyB, userB, principalB, subjectB);
    assert.equal(await sessions.resolve(companyB, (await sessionFor(tenant, user, principal, grantedSubject)).tokenHash), null);
    await withTenantTransaction(pool, companyB, 'kavaroutes_api', async c => {
      const scopes = await c.query('SELECT scope_kind FROM platform.membership_scope_grant');
      assert.equal(scopes.rowCount, 2);
      assert.equal((await c.query('SELECT * FROM platform.membership_capability_grant')).rowCount, 0, 'company A capability grants stay invisible');
    });
    assert.equal((await authorityApi.inject({url:`/v1/organizations/${tenant}/dispatch-board/2026-09-16`, headers:companyBSession.headers})).statusCode, 404);
    assert.equal((await authorityApi.inject({url:`/v1/organizations/${companyB}/dispatch-board/2026-09-16`, headers:companyBSession.headers})).statusCode, 503);
    // Concurrent revocation against an in-flight authorized transaction. Ordering
    // rule: authority is decided from the persisted generation when the request is
    // authenticated, so a revocation committed after that snapshot does not abort
    // the already-authorized transaction, but the next request, socket upgrade or
    // revalidation denies because the generation no longer matches.
    const reader = await pool.connect(), revoker = await pool.connect();
    try {
      await reader.query('BEGIN'); await reader.query("SELECT set_config('app.tenant_id',$1,true)", [tenant]);
      // Plain MVCC read: no lock is held, so the concurrent revocation cannot block.
      const observed = Number((await reader.query('SELECT authorization_generation FROM platform.application_membership WHERE tenant_id=$1', [tenant])).rows[0].authorization_generation);
      await revoker.query('BEGIN'); await revoker.query("SELECT set_config('app.tenant_id',$1,true)", [tenant]);
      await revoker.query("UPDATE platform.membership_scope_grant SET active=false WHERE tenant_id=$1 AND scope_kind='BRANCH'", [tenant]);
      await revoker.query('COMMIT');
      await reader.query('COMMIT');
      assert.ok(await generationOf(tenant) > observed, 'revocation advanced the membership generation');
    } finally { reader.release(); revoker.release(); }
    assert.equal(await sessions.resolve(tenant, elevatedSession.tokenHash), null,
      'the session authorized before the revocation is now unusable');
    const revokedPrincipal = await principalFor((await sessionFor(tenant, user, principal, grantedSubject)).headers);
    const revokedGeneration = await generationOf(tenant);
    assert.equal(revokedPrincipal.branchScopes.size, 0, 'revoked branch scope is gone');
    assert.deepEqual([...revokedPrincipal.fleetScopes], [fleetScope], 'the unrelated fleet grant survives');
    assert.throws(() => authorizeRealtimeSubscription({principal:revokedPrincipal, organizationId:tenant,
      authorizationGeneration:revokedGeneration, purpose:'DISPATCH_CONTROL',
      scope:{streamKind:'DISPATCH_DAY',scopeReference:branchScope,serviceDate:'2026-09-16'}}), /REALTIME_AUTHORIZATION_DENIED/);
    // Deactivating the membership denies everything even with grants in place:
    // no new session can be admitted at all.
    await withTenantTransaction(pool, tenant, 'kavaroutes_migration', c =>
      c.query('UPDATE platform.application_membership SET active=false WHERE tenant_id=$1', [tenant]));
    await assert.rejects(sessionFor(tenant, user, principal, grantedSubject), /SESSION_ADMISSION_DENIED/);
    assert.equal(await sessions.resolve(tenant, elevatedSession.tokenHash), null);
  } finally { await authorityApi.close(); }
}
