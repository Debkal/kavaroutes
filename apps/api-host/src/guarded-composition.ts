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
import {createAuthorizationGenerationSource,createTestOnlyCursorCodec,type RealtimeStore} from '@kavaroutes/realtime';
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
  const admission=createIdentityAdmission({verifyToken:options.verifyProviderToken,findMembership:createIdentityMembershipReader(options.pool)},
    {issuer:config.issuer,audience:config.audience,now:clock,maximumAuthenticationAgeSeconds:config.maximumAuthenticationAgeSeconds});
  // No Authorization-header or synthetic principal is ever interpreted here.
  const verifier=createBrowserPrincipalVerifier({origin:config.origin,signingKey:config.signingKey,resolve:sessions.resolve});
  createBrowserCredentials({origin:config.origin,signingKey:config.signingKey,now:clock});
  const application=createWp007PostgresApplication(options.pool,{etagSecret:config.etagSecret});
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
    verifier,etagSecret:config.etagSecret,cursorSecret:config.cursorSecret});
  app.addHook('onRequest',async(request,reply)=>{
    reply.header('cache-control','no-store').header('pragma','no-cache');
    if(guardedEdgeDecision({trustedProxyHops:config.trustedProxyHops,peerAddress:request.socket.remoteAddress,
      forwardedProto:request.headers['x-forwarded-proto']})!=='ALLOW')return reply.code(403).send({code:'GUARDED_EDGE_REQUIRED'});
    const path=request.url.split('?')[0]??'';
    if(!reviewedPaths.some(pattern=>pattern.test(path)))return reply.code(503).send({code:'RUNTIME_PATH_NOT_PROMOTED'});
  });
  const store=options.realtimeStore??createPostgresRealtimeStore(options.pool,createTestOnlyCursorCodec({secret:config.cursorSecret}));
  const revalidate=createBrowserRealtimeRevalidator(verifier);
  const gateway=await registerWp009Realtime(app,{store,generationSource:createAuthorizationGenerationSource(),
    allowedOrigins:new Set([config.origin]),now,
    revalidateBrowserSession:(request:FastifyRequest,principal)=>revalidate({method:request.method,headers:request.headers},principal)});
  await registerBrowserAuth(app,{origin:config.origin,signingKey:config.signingKey,
    ports:{admit:admission.admit,issue:sessions.issue,resolve:sessions.resolve,revoke:sessions.revoke}});
  let stopped=false;
  let timer:ReturnType<typeof setTimeout>|undefined;
  const tick=async()=>{ if(stopped)return;
    try{await gateway.fanOut();gateway.heartbeatSweep();gateway.authorizationSweep();}
    catch{gateway.drain();}
    finally{if(!stopped)timer=setTimeout(()=>void tick(),1000);} };
  app.addHook('onClose',async()=>{stopped=true;if(timer)clearTimeout(timer);gateway.drain();});
  await app.ready();
  return Object.freeze({app,config,gateway,origin:config.origin,
    async start(){await app.listen({host:config.host,port:config.port});void tick();},
    /** Closes the host's own resources. The caller-owned pool is left untouched. */
    async close(){stopped=true;if(timer)clearTimeout(timer);gateway.drain();await app.close();}});
}
