import { createWp007Api, createWp007PostgresApplication, createPostgresDriverShiftService, createSyntheticTestVerifier,
  createPostgresDriverActionService, createPostgresDriverPrecheckService, createPostgresDriverShiftStateReader, createPostgresDriverSignatureService, createPostgresDispatchService, createPostgresRouteProposalService, createPostgresDriverClosureService } from '@kavaroutes/api-contracts';
import { createDriverItineraryReader,createDispatchTrackingReader } from '@kavaroutes/postgres-persistence';
import {createPostgresFacilityService,createPostgresBrowserRecoveryService} from '@kavaroutes/api-contracts';
import {createPostgresClientService} from '@kavaroutes/api-contracts';
import {createPostgresDriverLoginService} from '@kavaroutes/api-contracts';
import {createPostgresDriverLocationService} from '@kavaroutes/api-contracts';
import {createPostgresAccountingApiService} from '@kavaroutes/api-contracts';
import { createTestOnlyCursorCodec, createAuthorizationGenerationSource, authorizeRealtimeSubscription } from '@kavaroutes/realtime';
import { createPostgresRealtimeStore } from '@kavaroutes/realtime/postgres';
import { registerWp009Realtime } from '@kavaroutes/realtime/fastify';
import {withTenantTransaction} from '@kavaroutes/postgres-persistence';
import { makePool, verifyRuntimeDatabase } from './database.mjs';
import { validateConfig, tenantId, branchScopeReference } from './config.mjs';
import {createDriverSessions} from './driver-sessions.mjs';
import {createGeoapifyRoadRoutingService} from './road-routing.mjs';

export async function createRuntimeApi(input) {
  const config = validateConfig(input);
  if (new URL(config.databaseUrl).username !== 'kr_cloud_api') throw new Error('RUNTIME_DATABASE_ROLE_INVALID');
  const pool = makePool(config);
  const sessions=createDriverSessions({synthetic:createSyntheticTestVerifier(),allowSyntheticDriver:process.env.KR_CLOUD_LOCAL_TEST==='1',credentialVersion:async(organizationId,driverId)=>
    withTenantTransaction(pool,organizationId,'kavaroutes_api',async client=>{
      const row=(await client.query(`SELECT status,credential_version FROM platform.driver_credential WHERE tenant_id=$1 AND driver_id=$2`,[organizationId,driverId])).rows[0];
      return row?{status:String(row.status),version:Number(row.credential_version)}:null;
    })});
  const verifier={verify:authorization=>sessions.verify(authorization)};
  const application = createWp007PostgresApplication(pool, { etagSecret: config.etagSecret });
  const checkDatabase = async () => { await verifyRuntimeDatabase(pool, 'api'); await application.listTrips(tenantId, { limit: 1 }); };
  const app = await createWp007Api({ application, driverItineraryReader: createDriverItineraryReader(pool),
    browserRecoveryService:createPostgresBrowserRecoveryService(pool,{application,dispatchService:createPostgresDispatchService(pool,{etag:application.etag}),routeProposalService:createPostgresRouteProposalService(pool),driverClosureService:createPostgresDriverClosureService(pool)}),
    dispatchService: createPostgresDispatchService(pool,{etag:application.etag}),
    routeProposalService: createPostgresRouteProposalService(pool),
    roadRoutingService: createGeoapifyRoadRoutingService(pool,{apiKey:process.env.GEOAPIFY_API_KEY}),
    facilityService:createPostgresFacilityService(pool),
    clientService:createPostgresClientService(pool),
    driverLoginService:createPostgresDriverLoginService(pool,{allowUnauthenticatedLogin:true}),
    publicDriverLogin:true,
    issueDriverSession:(organizationId,state)=>sessions.issue(organizationId,state),
    driverShiftService: createPostgresDriverShiftService(pool),
    driverShiftReader: createPostgresDriverShiftStateReader(pool),
    driverActionService: createPostgresDriverActionService(pool,{etag:application.etag}),
    driverPrecheckService: createPostgresDriverPrecheckService(pool),
    driverPostcheckService: createPostgresDriverPrecheckService(pool,{stage:'POST'}),
    driverClosureService: createPostgresDriverClosureService(pool),
    driverSignatureService: createPostgresDriverSignatureService(pool,{etag:application.etag}),
    driverLocationService: createPostgresDriverLocationService(pool),
    dispatchTrackingReader: createDispatchTrackingReader(pool),
    accountingService: createPostgresAccountingApiService(pool),
    verifier, etagSecret: config.etagSecret, cursorSecret: `synthetic-cursor-secret-${config.cursorSecret}` });
  const store = createPostgresRealtimeStore(pool, createTestOnlyCursorCodec({ secret: config.cursorSecret }));
  let gateway;
  let stopped = false;
  let timer;
  // Refuse scaffold-only domain endpoints rather than silently presenting fake persistence.
  app.addHook('onRequest', async (request, reply) => {
    const path = request.url.split('?')[0];
    if(/^\/v1\/organizations\/[^/]+\/facility\/(?:days\/\d{4}-\d{2}-\d{2}|trips\/[^/]+)$/.test(path))return;
    if(/^\/v1\/organizations\/[^/]+\/browser-commands(?:\/pending|\/[^/]+\/(?:execute|acknowledge))?$/.test(path))return;
    const routeProposalPath=/^\/v1\/organizations\/[^/]+\/(?:(?:driver|dispatch)\/shifts\/[^/]+\/route-proposals|dispatch\/route-proposals\/[^/]+\/commands\/decide)$/.test(path);
    const closurePath=/^\/v1\/organizations\/[^/]+\/(?:(?:driver|dispatch)\/shifts\/[^/]+\/status|driver\/shifts\/[^/]+\/commands\/(?:postcheck|close)|dispatch\/shifts\/[^/]+\/(?:return-review|commands\/override-return))$/.test(path);
    // The fixture-only return endpoint remains available to disposable integration
    // tests; the live runtime never publishes a fabricated location as real proof.
    if(process.env.KR_CLOUD_LOCAL_TEST==='1'&&/^\/v1\/organizations\/[^/]+\/driver\/shifts\/[^/]+\/synthetic-location-batches$/.test(path))return;
    // Live driver positioning: the driver's device reports fixes and dispatch reads the
    // day's map. Coordinates stay inside these two authorized routes.
    const locationPath=/^\/v1\/organizations\/[^/]+\/(?:driver\/shifts\/[^/]+\/location-batches|dispatch\/tracking\/\d{4}-\d{2}-\d{2})$/.test(path);
    // The money surface: costing, estimates, payer invoices and client history.
    const accountingPath=/^\/v1\/organizations\/[^/]+\/(?:billing\/(?:cost-profile(?:\/commands\/update)?|estimates\/\d{4}-\d{2}-\d{2}|invoices(?:\/commands\/create|\/[^/]+(?:\/commands\/forward)?)?)|clients\/[^/]+\/history)$/.test(path);
    const roadRoutingPath=/^\/v1\/organizations\/[^/]+\/(?:dispatch\/legs\/[^/]+\/road-route(?:\/preview|\/commands\/select)?|driver\/legs\/[^/]+\/road-route)$/.test(path);
    if(closurePath)return; // Authentication/capability checks remain in the registered handlers.
    if(locationPath)return;
    if(accountingPath)return;
    if(roadRoutingPath)return;
    if (!routeProposalPath && !/^\/(health\/ready|v1\/me|v1\/realtime|v1\/organizations\/[^/]+\/(trips(?:\/[^/]+(?:\/commands\/cancel)?)?|clients(?:\/commands\/create|\/[^/]+\/commands\/update)?|fleet\/drivers\/commands\/create|driver-logins\/(?:commands\/(?:create|verify)|[^/]+\/commands\/claim)|dispatch-board\/\d{4}-\d{2}-\d{2}|dispatch\/runs\/(?:[^/]+\/commands\/(?:assign|unassign)|commands\/plan)|driver\/(?:itineraries\/\d{4}-\d{2}-\d{2}|action-batches|shifts\/(?:commands\/start|assignments\/[^/]+|[^/]+\/(?:commands\/precheck|legs\/[^/]+\/evidence\/signatures)))|runtime-dispatch-snapshot|realtime-change-queries))$/.test(path)) {
      return reply.code(503).send({ code: 'RUNTIME_PATH_NOT_PROMOTED' });
    }
  });
  app.get('/health/ready', async (_request, reply) => {
    // The build id is what the served bundle can be compared against, so a stale image
    // is visible instead of presenting as broken data (audit WEB-A-004/WEB-A-009).
    const build = process.env.KR_BUILD_ID ?? 'unknown';
    try { await checkDatabase(); return { status: 'ready', profile: 'private-synthetic', build }; }
    catch { return reply.code(503).send({ status: 'unavailable', build }); }
  });
  await app.register(async scope => {
    scope.decorateRequest('wp007Context');
    scope.addHook('onRequest', async (request, reply) => {
      const principal = await verifier.verify(request.headers.authorization);
      if (!principal) return reply.code(401).send({ code: 'AUTHENTICATION_REQUIRED' });
      request.wp007Context = { principal };
    });
    gateway = await registerWp009Realtime(scope, { store, generationSource: createAuthorizationGenerationSource(),
      allowedOrigins: new Set(['http://kavaroutes.test']), maximumConnections: 50 });
    scope.get('/v1/organizations/:organizationId/runtime-dispatch-snapshot', async (request, reply) => {
      const serviceDate = request.query.serviceDate;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(serviceDate ?? '')) return reply.code(400).send({ code: 'INVALID_SERVICE_DATE' });
      try {
        const authorization = authorizeRealtimeSubscription({ principal: request.wp007Context.principal,
          organizationId: request.params.organizationId, authorizationGeneration: 1, purpose: 'DISPATCH_CONTROL',
          scope: { streamKind: 'DISPATCH_DAY', scopeReference: branchScopeReference, serviceDate } });
        reply.header('cache-control', 'no-store');
        return await store.snapshot(authorization);
      } catch { return reply.code(404).send({ code: 'RESOURCE_NOT_FOUND' }); }
    });
  });
  const tick = async () => {
    if (stopped) return;
    try { await gateway.fanOut(); gateway.heartbeatSweep(); gateway.authorizationSweep(); }
    catch { gateway.drain(); }
    finally { if (!stopped) timer = setTimeout(() => void tick(), 1000); }
  };
  app.addHook('onClose', async () => { stopped = true; clearTimeout(timer); gateway.drain(); await pool.end(); });
  await app.ready();
  return { app, pool, store, async start() { await checkDatabase(); await app.listen({ host: '127.0.0.1', port: config.port }); void tick(); },
    async close() { stopped = true; clearTimeout(timer); gateway.drain(); await app.close(); } };
}
