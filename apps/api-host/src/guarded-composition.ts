/** Reviewed `guarded-live` API host composition.
 *
 * Mounts the real session-backed REST and WebSocket application: persisted
 * company sessions resolve the principal, `/auth/*` exists only here, and a
 * synthetic or Bearer principal is never accepted in this profile. The private
 * synthetic runtime keeps its own composition (`infra/gcp/runtime/api.mjs`) and is
 * not weakened by anything in this file.
 *
 * The caller owns the database pool and the activation decision. `activate()` is
 * awaited before any session store, route, gateway or provider port is created, so
 * importing or constructing this module cannot switch a live host on by itself.
 */
import type {FastifyInstance, FastifyRequest} from 'fastify';
import {createWp007Api,createWp007PostgresApplication,createPostgresBrowserRecoveryService,createPostgresDispatchService,
  createPostgresDriverActionService,createPostgresDriverClosureService,createPostgresDriverPrecheckService,
  createPostgresDriverShiftService,createPostgresDriverShiftStateReader,createPostgresDriverSignatureService,
  createPostgresFacilityService,createPostgresRouteProposalService} from '@kavaroutes/api-contracts';
import {createIdentityAdmission,type VerifiedIdentity} from '@kavaroutes/api-contracts/identity-admission';
import {createApplicationSessionStore,createIdentityMembershipReader} from '@kavaroutes/postgres-persistence';
import {createGuardedDriverItineraryReader} from './guarded-driver-itinerary.js';
import {contextPrincipal,ProtocolError,type RequestGuard} from '@kavaroutes/api-contracts';
import {createProviderRevocationSweeper} from './provider-session-revocation.js';
import {createGuardedProviderRevocationPorts,subjectHandle,type GuardedProviderAccounts} from './guarded-provider-revocation.js';
import {authorizeRealtimeSubscription,createAuthorizationGenerationSource,createTestOnlyCursorCodec,type RealtimeStore} from '@kavaroutes/realtime';
import {companyBranchScope} from '@kavaroutes/api-contracts/security';
import {registerWp009Realtime} from '@kavaroutes/realtime/fastify';
import {createPostgresRealtimeStore} from '@kavaroutes/realtime/postgres';
import {createBrowserCredentials} from './browser-credentials.js';
import {createBrowserPrincipalVerifier,createBrowserRealtimeRevalidator} from './browser-principal.js';
import {registerBrowserAuth} from './browser-auth.js';
import {validateGuardedConfig,type GuardedRuntimeConfig} from './guarded-config.js';

type DatabasePool=Parameters<typeof createApplicationSessionStore>[0];

/** Promoted business and bootstrap paths for this profile. Anything else fails
 * visibly instead of reaching a scaffold or placeholder handler. */
const reviewedPaths:readonly RegExp[]=[
  /^\/health\/ready$/,
  /^\/auth\/(?:challenge|login|logout|session)$/,
  /^\/v1\/me$/,
  /^\/v1\/realtime$/,
  /^\/v1\/organizations\/[^/]+\/realtime-change-queries$/,
  /^\/v1\/organizations\/[^/]+\/trips(?:\/[^/]+(?:\/commands\/cancel)?)?$/,
  /^\/v1\/organizations\/[^/]+\/dispatch-board\/\d{4}-\d{2}-\d{2}$/,
  /^\/v1\/organizations\/[^/]+\/dispatch\/runs\/[^/]+\/commands\/assign$/,
  /^\/v1\/organizations\/[^/]+\/dispatch\/route-proposals\/[^/]+\/commands\/decide$/,
  /^\/v1\/organizations\/[^/]+\/dispatch\/shifts\/[^/]+\/return-review$/,
  /^\/v1\/organizations\/[^/]+\/dispatch\/shifts\/[^/]+\/commands\/override-return$/,
  /^\/v1\/organizations\/[^/]+\/driver\/itineraries\/\d{4}-\d{2}-\d{2}$/,
  /^\/v1\/organizations\/[^/]+\/driver\/action-batches$/,
  /^\/v1\/organizations\/[^/]+\/driver\/shifts\/commands\/start$/,
  /^\/v1\/organizations\/[^/]+\/driver\/shifts\/assignments\/[^/]+$/,
  /^\/v1\/organizations\/[^/]+\/driver\/shifts\/[^/]+\/status$/,
  /^\/v1\/organizations\/[^/]+\/driver\/shifts\/[^/]+\/commands\/precheck$/,
  /^\/v1\/organizations\/[^/]+\/driver\/shifts\/[^/]+\/commands\/postcheck$/,
  /^\/v1\/organizations\/[^/]+\/driver\/shifts\/[^/]+\/commands\/close$/,
  /^\/v1\/organizations\/[^/]+\/driver\/shifts\/[^/]+\/legs\/[^/]+\/evidence\/signatures$/,
  /^\/v1\/organizations\/[^/]+\/driver\/shifts\/[^/]+\/synthetic-location-batches$/,
  /^\/v1\/organizations\/[^/]+\/(?:driver|dispatch)\/shifts\/[^/]+\/route-proposals$/,
  /^\/v1\/organizations\/[^/]+\/dispatch\/shifts\/[^/]+\/route-proposals$/,
  /^\/v1\/organizations\/[^/]+\/browser-commands(?:\/pending|\/[^/]+\/(?:execute|acknowledge))?$/,
  /^\/v1\/organizations\/[^/]+\/facility\/days\/\d{4}-\d{2}-\d{2}$/,
  /^\/v1\/organizations\/[^/]+\/facility\/trips\/[^/]+$/,
  /^\/v1\/organizations\/[^/]+\/runtime-dispatch-snapshot$/,
];

const loopbackPeers=new Set(['127.0.0.1','::1','::ffff:127.0.0.1']);

/** Edge trust decision for one request. With a trusted TLS edge (`hops` 1) the
 * listener still only accepts a loopback peer, and forwarded metadata is honoured
 * only when the edge says it terminated HTTPS. Direct non-loopback traffic is
 * always refused, so publishing the port would not expose the application. */
export function guardedEdgeDecision(input:{trustedProxyHops:0|1;peerAddress:string|undefined;forwardedProto:unknown}):'ALLOW'|'EDGE_REQUIRED' {
  if(!loopbackPeers.has(input.peerAddress??''))return 'EDGE_REQUIRED';
  if(input.trustedProxyHops===0)return 'ALLOW';
  return input.forwardedProto==='https'?'ALLOW':'EDGE_REQUIRED';
}

export interface GuardedApiHostOptions {
  readonly config:unknown;
  /** Must resolve only after explicit human-approved activation. */
  readonly activate:()=>Promise<void>;
  readonly verifyProviderToken:(token:string)=>Promise<VerifiedIdentity>;
  /** Provider account state and token-revocation timestamps. Required: a guarded
   * host that cannot answer both "is the account disabled" and "was this
   * authentication revoked" must not be composed, because an enabled account is
   * not proof of unrevoked authentication. */
  readonly providerAccounts?:GuardedProviderAccounts;
  readonly providerRevocation?:{
    readonly maximumStalenessMilliseconds?:number;
    readonly batchSize?:number;
    readonly checkDeadlineMilliseconds?:number;
    readonly sweepIntervalMilliseconds?:number;
  };
  readonly pool:DatabasePool;
  /** Injectable for tests; the default persists to PostgreSQL. */
  readonly realtimeStore?:RealtimeStore;
  readonly now?:()=>Date;
  readonly clock?:()=>number;
}

export async function createGuardedApiHost(options:GuardedApiHostOptions) {
  const config:GuardedRuntimeConfig=validateGuardedConfig(options.config);
  if(typeof options.activate!=='function'||typeof options.verifyProviderToken!=='function')throw new Error('GUARDED_PORTS_INVALID');
  // Activation precedes every session, route and provider object in this profile.
  await options.activate();
  const now=options.now??(()=>new Date());
  const clock=options.clock??(()=>Math.floor(Date.now()/1000));
  const sessions=createApplicationSessionStore(options.pool);
  if(!options.providerAccounts)throw new Error('GUARDED_PROVIDER_ACCOUNTS_REQUIRED');
  const revocation=createProviderRevocationSweeper(
    createGuardedProviderRevocationPorts(options.pool,{accounts:options.providerAccounts}),{
      maximumStalenessMilliseconds:options.providerRevocation?.maximumStalenessMilliseconds??900_000,
      ...(options.providerRevocation?.batchSize===undefined?{}:{batchSize:options.providerRevocation.batchSize}),
      ...(options.providerRevocation?.checkDeadlineMilliseconds===undefined?{}:{checkDeadlineMilliseconds:options.providerRevocation.checkDeadlineMilliseconds}),
      now:()=>now().getTime()});
  const sweepIntervalMilliseconds=options.providerRevocation?.sweepIntervalMilliseconds??60_000;
  // Every persisted session is resolved through the provider gate: a disabled
  // account or a revoked authentication loses the session (401), and a provider
  // this host cannot verify at admission time fails closed (503) instead of
  // being read as still valid.
  const verifySession=async(organizationId:string,tokenHash:string,csrfHash:string)=>{
    const row=await sessions.resolve(organizationId,tokenHash,csrfHash);
    if(!row)return null;
    // Admission and the sweep must use the same tenant-scoped handle, otherwise
    // the gate would look up evidence the sweeper never recorded.
    const decision=await revocation.authorize({subject:subjectHandle(organizationId,row.subject),sessionAuthenticatedAt:row.createdAt});
    if(decision.allowed)return row;
    if(decision.reason==='PROVIDER_ACCOUNT_DISABLED'||decision.reason==='PROVIDER_AUTHENTICATION_REVOKED')return null;
    throw new ProtocolError(503,'PROVIDER_VERIFICATION_UNAVAILABLE','provider verification unavailable');
  };
  const admission=createIdentityAdmission({verifyToken:options.verifyProviderToken,findMembership:createIdentityMembershipReader(options.pool)},
    {issuer:config.issuer,audience:config.audience,now:clock,maximumAuthenticationAgeSeconds:config.maximumAuthenticationAgeSeconds});
  // No Authorization-header or synthetic principal is ever interpreted here.
  const verifier=createBrowserPrincipalVerifier({origin:config.origin,signingKey:config.signingKey,resolve:verifySession});
  // The guarded scope below authenticates every request with the same persisted
  // browser-session verifier the wp007 lifecycle plugin uses. Fail closed at
  // construction if that verifier cannot resolve a request at all.
  const verifyBrowserRequest=verifier.verifyRequest?.bind(verifier);
  if(!verifyBrowserRequest)throw new Error('GUARDED_VERIFIER_INVALID');
  createBrowserCredentials({origin:config.origin,signingKey:config.signingKey,now:clock});
  // Edge trust plus the promoted-path allowlist, as one guard used in two places.
  // It has to be installed inside the API lifecycle scope as well as on this
  // instance: a hook added to an outer instance after `createWp007Api` returns
  // never runs for the routes the lifecycle plugin registered, so an outer hook
  // alone would leave every business route ungated.
  const promotedPathGuard:RequestGuard=async(request,reply)=>{
    reply.header('cache-control','no-store').header('pragma','no-cache');
    if(guardedEdgeDecision({trustedProxyHops:config.trustedProxyHops,peerAddress:request.socket.remoteAddress,
      forwardedProto:request.headers['x-forwarded-proto']})!=='ALLOW')return reply.code(403).send({code:'GUARDED_EDGE_REQUIRED'});
    const path=request.url.split('?')[0]??'';
    if(!reviewedPaths.some(pattern=>pattern.test(path)))return reply.code(503).send({code:'RUNTIME_PATH_NOT_PROMOTED'});
    return undefined;
  };
  // Declared guarded profile: a test-marked key is still refused, and the
  // reviewed configuration above owns the strength rule for this secret.
  const application=createWp007PostgresApplication(options.pool,{etagSecret:config.etagSecret,secretProfile:'reviewed-guarded'});
  const app:FastifyInstance=await createWp007Api({application,driverItineraryReader:createGuardedDriverItineraryReader(options.pool),
    browserRecoveryService:createPostgresBrowserRecoveryService(options.pool,{application,dispatchService:createPostgresDispatchService(options.pool,{etag:application.etag}),
      routeProposalService:createPostgresRouteProposalService(options.pool),driverClosureService:createPostgresDriverClosureService(options.pool)}),
    dispatchService:createPostgresDispatchService(options.pool,{etag:application.etag}),
    routeProposalService:createPostgresRouteProposalService(options.pool),
    facilityService:createPostgresFacilityService(options.pool),
    driverShiftService:createPostgresDriverShiftService(options.pool),
    driverShiftReader:createPostgresDriverShiftStateReader(options.pool),
    driverActionService:createPostgresDriverActionService(options.pool,{etag:application.etag}),
    driverPrecheckService:createPostgresDriverPrecheckService(options.pool),
    driverPostcheckService:createPostgresDriverPrecheckService(options.pool,{stage:'POST'}),
    driverClosureService:createPostgresDriverClosureService(options.pool),
    driverSignatureService:createPostgresDriverSignatureService(options.pool,{etag:application.etag}),
    verifier,etagSecret:config.etagSecret,cursorSecret:config.cursorSecret,secretProfile:'reviewed-guarded',
    requestGuards:[promotedPathGuard]});
  // The same guard on this instance covers the routes this composition registers
  // itself below (`/auth/*`, readiness, realtime, the dispatch snapshot).
  app.addHook('onRequest',promotedPathGuard);
  const store=options.realtimeStore??createPostgresRealtimeStore(options.pool,createTestOnlyCursorCodec({secret:config.cursorSecret}));
  const revalidate=createBrowserRealtimeRevalidator(verifier);
  const generationSource=createAuthorizationGenerationSource();
  // Readiness is unauthenticated and stays outside the authenticated scope. It
  // reports only whether this host can reach its own database through the pool it
  // was given; it never reports provider, credential or configuration detail.
  app.get('/health/ready',async(_request,reply)=>{
    try{await options.pool.query('SELECT 1');reply.header('cache-control','no-store');return {status:'ready',profile:'guarded-live'};}
    catch{return reply.code(503).send({status:'unavailable'});}
  });
  // Realtime and the dispatch snapshot are registered inside their own
  // session-authenticated scope. The wp007 lifecycle plugin installs its
  // authentication hook and `wp007Context` decoration inside its own encapsulated
  // scope, so a route registered on the parent app would never see an
  // authenticated principal. `/auth/*` stays separately scoped and
  // unauthenticated below.
  let gateway!:Awaited<ReturnType<typeof registerWp009Realtime>>;
  await app.register(async scope=>{
    scope.decorateRequest('wp007Context');
    scope.addHook('onRequest',async(request,reply)=>{
      // Only the persisted browser session verifier is consulted here; no
      // Authorization header, Bearer token or synthetic principal is accepted.
      const principal=await verifyBrowserRequest({method:request.method,headers:request.headers});
      if(!principal)return reply.code(401).send({code:'AUTHENTICATION_REQUIRED'});
      request.wp007Context={requestId:request.id,startedAt:performance.now(),principal,resultCode:'UNSET'};
    });
    gateway=await registerWp009Realtime(scope,{store,generationSource,allowedOrigins:new Set([config.origin]),now,
      revalidateBrowserSession:(request:FastifyRequest,principal)=>revalidate({method:request.method,headers:request.headers},principal)});
    scope.get('/v1/organizations/:organizationId/runtime-dispatch-snapshot',async(request,reply)=>{
      const principal=contextPrincipal(request);
      const serviceDate=(request.query as {serviceDate?:unknown}).serviceDate;
      if(typeof serviceDate!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(serviceDate))return reply.code(400).send({code:'INVALID_SERVICE_DATE'});
      const organizationId=(request.params as {organizationId:string}).organizationId;
      try{
        // The company's own canonical branch scope, never the fixture constant.
        const authorization=authorizeRealtimeSubscription({principal,organizationId,
          authorizationGeneration:generationSource.current(principal.id),purpose:'DISPATCH_CONTROL',
          scope:{streamKind:'DISPATCH_DAY',scopeReference:companyBranchScope(organizationId),serviceDate}});
        reply.header('cache-control','no-store');
        return await store.snapshot(authorization);
      }catch{return reply.code(404).send({code:'RESOURCE_NOT_FOUND'});}
    });
  });
  await registerBrowserAuth(app,{origin:config.origin,signingKey:config.signingKey,
    ports:{admit:admission.admit,issue:sessions.issue,resolve:sessions.resolve,revoke:sessions.revoke}});
  let stopped=false;
  let timer:ReturnType<typeof setTimeout>|undefined;
  let sweepTimer:ReturnType<typeof setInterval>|undefined;
  const stopSweeps=()=>{if(sweepTimer)clearInterval(sweepTimer);sweepTimer=undefined;};
  const startSweeps=()=>{ if(stopped||sweepTimer)return;
    void revocation.runOnce().catch(()=>{});
    sweepTimer=setInterval(()=>{void revocation.runOnce().catch(()=>{});},sweepIntervalMilliseconds);
    // Never hold the process (or a test runner) open for the sweep.
    sweepTimer.unref?.(); };
  const tick=async()=>{ if(stopped)return;
    try{await gateway.fanOut();gateway.heartbeatSweep();gateway.authorizationSweep();}
    catch{gateway.drain();}
    finally{if(!stopped)timer=setTimeout(()=>void tick(),1000);} };
  app.addHook('onClose',async()=>{stopped=true;if(timer)clearTimeout(timer);stopSweeps();gateway.drain();});
  await app.ready();
  return Object.freeze({app,config,gateway,revocation,origin:config.origin,
    async start(){await app.listen({host:config.host,port:config.port});void tick();startSweeps();},
    /** Closes the host's own resources. The caller-owned pool is left untouched. */
    async close(){stopped=true;if(timer)clearTimeout(timer);stopSweeps();gateway.drain();await app.close();}});
}
