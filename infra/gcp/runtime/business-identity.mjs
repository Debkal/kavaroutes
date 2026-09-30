import {createRemoteJWKSet,jwtVerify} from 'jose';
import {createApplicationSessionStore,createIdentityMembershipReader,withTenantTransaction} from '@kavaroutes/postgres-persistence';
import {createMembershipPrincipal} from '@kavaroutes/api-contracts/security';
import {createBrowserPrincipalVerifier} from '../../../apps/api-host/dist/browser-principal.js';
import {createBrowserCredentials} from '../../../apps/api-host/dist/browser-credentials.js';
import {registerBrowserAuth} from '../../../apps/api-host/dist/browser-auth.js';
import {readSecretJson} from './config.mjs';

const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
export function validateBusinessIdentityConfig(value){
 if(!value||value.version!==1||value.origin!=='https://app.kavaroutes.com'||typeof value.signingKey!=='string'||
  !/^[A-Za-z0-9_-]{43}$/.test(value.signingKey)||Object.keys(value).some(key=>!['version','origin','signingKey','testAccess','firebase','adminAccess'].includes(key)))throw Error('BUSINESS_IDENTITY_CONFIG_INVALID');
 for(const key of ['testAccess','adminAccess']){
  const access=value[key];
  if(access!=null&&(!/^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/.test(access.issuer??'')||
   !/^[a-f0-9]{64}$/.test(access.audience??'')||(key==='testAccess'&&!uuid.test(access.organizationId??''))))throw Error('BUSINESS_IDENTITY_CONFIG_INVALID');
 }
 const firebase=value.firebase;
 if(firebase!=null&&(!/^[a-z][a-z0-9-]{4,62}$/.test(firebase.projectId??'')||!/^[-A-Za-z0-9_]{1,128}$/.test(firebase.tenantId??'')||
  !/^[A-Za-z0-9_-]{20,256}$/.test(firebase.apiKey??'')||!/^[-a-z0-9]+\.firebaseapp\.com$/.test(firebase.authDomain??'')))throw Error('BUSINESS_IDENTITY_CONFIG_INVALID');
 if(!value.testAccess&&!firebase)throw Error('BUSINESS_IDENTITY_PROVIDER_REQUIRED');
 return Object.freeze(value);
}

/** Read one explicit membership and its grants in one tenant transaction. Neither
 * email, client persona nor Cloudflare admission can create a membership. */
export function createBusinessMembershipReader(pool){
 return async(organizationId,issuer,subject)=>withTenantTransaction(pool,organizationId,'kavaroutes_api',async client=>{
  const row=(await client.query(`SELECT m.principal_id,m.role,m.driver_id,m.authorization_generation,u.display_name,
    COALESCE((SELECT array_agg(g.scope_kind ORDER BY g.scope_kind) FROM platform.membership_scope_grant g
      WHERE g.tenant_id=m.tenant_id AND g.user_id=m.user_id AND g.active),'{}') AS scope_kinds,
    COALESCE((SELECT array_agg(g.capability ORDER BY g.capability) FROM platform.membership_capability_grant g
      WHERE g.tenant_id=m.tenant_id AND g.user_id=m.user_id AND g.active),'{}') AS capability_grants
   FROM platform.identity_binding b JOIN platform.application_user u ON u.tenant_id=b.tenant_id AND u.id=b.user_id
   JOIN platform.application_membership m ON m.tenant_id=u.tenant_id AND m.user_id=u.id
   WHERE b.tenant_id=$1 AND b.issuer=$2 AND b.subject=$3 AND b.active AND u.active AND m.active`,
  [organizationId,issuer,subject])).rows[0];
  if(!row||row.role!=='DISPATCHER'||row.driver_id!==null)return null;
  const generation=Number(row.authorization_generation);
  if(!Number.isSafeInteger(generation)||generation<1||!uuid.test(row.principal_id))throw Error('BUSINESS_MEMBERSHIP_INVALID');
  const principal=createMembershipPrincipal({principalId:row.principal_id,organizationId,role:'DISPATCHER',driverId:null,
   capabilityGrants:row.capability_grants,scopeKinds:row.scope_kinds});
  return {principal,generation};
 });
}

/** Keys are cached by jose; tokens and membership authority are never cached. */
export function createAccessIdentityVerifier(config,keys){
 const jwks=keys??createRemoteJWKSet(new URL(`${config.issuer}/cdn-cgi/access/certs`),{timeoutDuration:5000});
 return async headers=>{
  const token=headers['cf-access-jwt-assertion'];
  if(typeof token!=='string'||token.length>16384)return null;
  try{
   const {payload}=await jwtVerify(token,jwks,{issuer:config.issuer,audience:config.audience,algorithms:['RS256'],requiredClaims:['exp','iat','sub','email']});
   return typeof payload.sub==='string'&&payload.sub.length>0&&payload.sub.length<=128&&typeof payload.email==='string'
    ?{issuer:config.issuer,subject:payload.sub}:null;
  }catch{return null;}
 };
}

/** One account lookup per subject per 30 seconds, with shared in-flight work,
 * bounded memory and a deadline. Database membership revocation stays immediate. */
export function createPooledAccountLookup(lookup,{now=()=>Date.now(),ttlMs=30000,maximum=128,deadlineMs=5000}={}){
 const entries=new Map();
 return async subject=>{
  const old=entries.get(subject);
  if(old&&(old.pending||old.expiresAt>now()))return old.pending??old.value;
  if(old)entries.delete(subject);
  if(entries.size>=maximum){
   const disposable=[...entries].find(([,row])=>!row.pending);
   if(!disposable)throw Error('BUSINESS_PROVIDER_CAPACITY');
   entries.delete(disposable[0]);
  }
  const entry={expiresAt:0,pending:null};entries.set(subject,entry);
  let timer;
  entry.pending=Promise.race([Promise.resolve().then(()=>lookup(subject)),new Promise((_,reject)=>{
   timer=setTimeout(()=>reject(Error('BUSINESS_PROVIDER_TIMEOUT')),deadlineMs);
  })]).then(value=>{entry.value=value;entry.expiresAt=now()+ttlMs;return value;}).catch(error=>{entries.delete(subject);throw error;}).finally(()=>{clearTimeout(timer);entry.pending=null;});
  return entry.pending;
 };
}

async function openBusinessProvider(config){
 if(!config)return null;
 if(process.env.FIREBASE_AUTH_EMULATOR_HOST)throw Error('BUSINESS_AUTH_EMULATOR_DENIED');
 const [{initializeApp,applicationDefault,deleteApp},{getAuth}]=await Promise.all([import('firebase-admin/app'),import('firebase-admin/auth')]);
 const app=initializeApp({projectId:config.projectId,credential:applicationDefault()},'runtime-business');
 const auth=getAuth(app).tenantManager().authForTenant(config.tenantId),accountLookup=createPooledAccountLookup(subject=>auth.getUser(subject)),issuer=`https://securetoken.google.com/${config.projectId}`;
 return {
  async verify(token){
   const identity=await auth.verifyIdToken(token,true),now=Math.floor(Date.now()/1000);
   if(identity.email_verified!==true||identity.firebase?.tenant!==config.tenantId||identity.iss!==issuer||
    identity.aud!==config.projectId||!Number.isSafeInteger(identity.auth_time)||now-identity.auth_time<0||now-identity.auth_time>300)throw Error('BUSINESS_SIGN_IN_DENIED');
   return {issuer,subject:identity.sub};
  },
  async authorize(session){
   const account=await accountLookup(session.subject);
   if(account.disabled||account.emailVerified!==true)return false;
   const validSince=Date.parse(account.tokensValidAfterTime);
   return Number.isFinite(validSince)&&Math.floor(validSince/1000)<Math.floor(Date.parse(session.createdAt)/1000);
  },close:()=>deleteApp(app),
 };
}

export async function createBusinessIdentity({pool,driverSessions,config:input,configFile,provider:injectedProvider,accessKeys}){
 const config=validateBusinessIdentityConfig(input??await readSecretJson(configFile));
 const signingKey=Buffer.from(config.signingKey,'base64url'),credentials=createBrowserCredentials({origin:config.origin,signingKey});
 const store=createApplicationSessionStore(pool),readMembership=createBusinessMembershipReader(pool),readAdmission=createIdentityMembershipReader(pool);
 const provider=injectedProvider??await openBusinessProvider(config.firebase);
 const testVerifier=config.testAccess?createAccessIdentityVerifier(config.testAccess,accessKeys):null;
 const adminVerifier=config.adminAccess?createAccessIdentityVerifier(config.adminAccess,accessKeys):null;
 const resolve=async(organizationId,tokenHash,csrfHash)=>{
  if(!provider)return null;
  const row=await store.resolve(organizationId,tokenHash,csrfHash);
  if(!row||!await provider.authorize(row))return null;
  return row;
 };
 const browser=createBrowserPrincipalVerifier({origin:config.origin,signingKey,resolve});
 const selectedOrganization=request=>{
  const path=/^\/v1\/organizations\/([a-f0-9-]+)\//.exec(request.url??'')?.[1];
  const selected=request.headers['x-kr-business-id'];
  if(path&&selected!==undefined&&path!==selected)return null;
  const id=path??selected;
  return typeof id==='string'&&uuid.test(id)?id:null;
 };
 const testPrincipal=async request=>{
  if(!testVerifier||request.headers.authorization!==undefined)return null;
  // The bypass belongs only to the explicit test business. Normal businesses
  // must hold their own persisted browser session, even after passing Access.
  const selected=selectedOrganization(request);
  if(selected!==config.testAccess.organizationId&&!(selected===null&&request.url==='/v1/realtime'))return null;
  if(request.headers['sec-fetch-site']!==undefined&&request.headers['sec-fetch-site']!=='same-origin')return null;
  if(!['GET','HEAD'].includes(request.method)&&
   (request.headers.origin!==config.origin||request.headers['x-kr-request']!=='business'))return null;
  if(request.headers.origin!==undefined&&request.headers.origin!==config.origin)return null;
  const identity=await testVerifier(request.headers);if(!identity)return null;
  return (await readMembership(config.testAccess.organizationId,identity.issuer,identity.subject))?.principal??null;
 };
 const verifier={
  verify:authorization=>driverSessions.verify(authorization),
  async verifyRequest(request){
   const authorization=request.headers.authorization;
   if(authorization!==undefined)return driverSessions.verify(authorization);
   const cookie=request.headers.cookie;
   if(typeof cookie==='string'&&cookie.split(';').some(part=>part.trim().startsWith('__Host-kr-session='))){
    const principal=await browser.verifyRequest(request);
    const selected=selectedOrganization(request);
    return principal&&(!selected||selected===principal.organizationId)?principal:null;
   }
   // Internal admin metrics uses its own audience and cannot authorize any
   // dispatch, billing or driver command, regardless of submitted headers.
   if(adminVerifier&&request.method==='GET'&&/^\/v1\/organizations\/[^/]+\/dispatch\/provider-usage(?:\?|$)/.test(request.url??'')){
    const id=selectedOrganization(request),identity=await adminVerifier(request.headers);
    if(id&&identity)return (await readMembership(id,identity.issuer,identity.subject))?.principal??null;
   }
   return testPrincipal(request);
  },
 };
 const revalidate=async(request,original)=>{
  const current=await verifier.verifyRequest(request);
  return !!current&&current.kind===original.kind&&current.id===original.id&&current.organizationId===original.organizationId&&
   ['capabilities','purposes','branchScopes','fleetScopes'].every(field=>[...current[field]].sort().join() === [...original[field]].sort().join());
 };
 const workspaces=async identity=>{
  const tenants=(await pool.query('SELECT platform.enrolled_tenants($1) AS id',[25])).rows;
  const result=[];
  // Only bootstrap enumerates the bounded enrolled set. Business requests read
  // one membership using their own tenant; this does not poll on every render.
  for(const {id} of tenants){
   const membership=await readMembership(id,identity.issuer,identity.subject);
   if(membership){const name=await withTenantTransaction(pool,id,'kavaroutes_api',async c=>(await c.query('SELECT synthetic_name FROM platform.organization WHERE tenant_id=$1 AND id=$1',[id])).rows[0]?.synthetic_name);
    result.push({organizationId:id,name:String(name??'Business workspace')});}
  }
  return result;
 };
 return {verifier,revalidate,config,
  async register(app){
   await registerBrowserAuth(app,{origin:config.origin,signingKey,ports:{issue:store.issue,resolve,resolveForLogout:store.resolve,revoke:store.revoke,
    async admit(token,organizationId){
     if(!provider)throw Error('BUSINESS_SIGN_IN_UNAVAILABLE');
     const identity=await provider.verify(token),row=await readAdmission(identity.issuer,identity.subject,organizationId);
     if(!row?.userActive||!row.membershipActive||!await readMembership(organizationId,identity.issuer,identity.subject))throw Error('BUSINESS_MEMBERSHIP_REQUIRED');
     return {organizationId,userId:row.userId,principalId:row.principalId,issuer:identity.issuer,subject:identity.subject,authorizationGeneration:row.authorizationGeneration};
    },
   }});
   app.get('/auth/config',async(_request,reply)=>reply.header('cache-control','no-store').send({authEnabled:!!provider,firebase:config.firebase??null}));
   let windowStart=Date.now(),attempts=0;
   app.post('/auth/businesses',{bodyLimit:20*1024},async(request,reply)=>{
    if(Date.now()-windowStart>=60000){windowStart=Date.now();attempts=0;}
    if(++attempts>30)return reply.code(429).header('retry-after','60').send({code:'AUTH_RATE_LIMITED'});
    try{
     credentials.assertSameOrigin(request.headers);credentials.verifyChallenge(request.headers.cookie,request.headers['x-kr-csrf']);
     if(!provider||typeof request.body?.token!=='string'||request.body.token.length>16384||Object.keys(request.body).join()!=='token')throw Error();
     return reply.header('cache-control','no-store').send({businesses:await workspaces(await provider.verify(request.body.token))});
    }catch{return reply.code(401).send({code:'BUSINESS_SIGN_IN_DENIED'});}
   });
   app.get('/auth/workspace',async(request,reply)=>{
    try{
    let principal=await browser.verifyRequest(request),csrf=null,mode='business';
    if(principal){csrf=credentials.recover(request.headers.cookie)?.csrf??null;}
    else if(config.testAccess){
     principal=await testPrincipal({method:request.method,url:request.url,headers:{...request.headers,'x-kr-business-id':config.testAccess.organizationId}});mode='test';
    }
    if(!principal)return reply.code(401).header('cache-control','no-store').send({code:'BUSINESS_SIGN_IN_REQUIRED'});
    return reply.header('cache-control','no-store').send({organizationId:principal.organizationId,principalId:principal.id,capabilities:[...principal.capabilities].sort(),csrf,mode});
    }catch{return reply.code(503).header('cache-control','no-store').send({code:'BUSINESS_SESSION_UNAVAILABLE'});}
   });
   app.addHook('onClose',async()=>{await provider?.close?.();});
  },
 };
}
