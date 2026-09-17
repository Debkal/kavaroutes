import { createWp007Api, createWp007PostgresApplication, createPostgresDriverShiftService, createSyntheticTestVerifier,
  createPostgresDriverActionService, createPostgresDriverPrecheckService, createPostgresDriverShiftStateReader, createPostgresDriverSignatureService, createPostgresDispatchService, createPostgresRouteProposalService, createPostgresDriverClosureService } from '@kavaroutes/api-contracts';
import { createDriverItineraryReader } from '@kavaroutes/postgres-persistence';
import {createPostgresFacilityService,createPostgresBrowserRecoveryService} from '@kavaroutes/api-contracts';
import {createPostgresClientService} from '@kavaroutes/api-contracts';
import {createPostgresDriverLoginService} from '@kavaroutes/api-contracts';
import { createTestOnlyCursorCodec, createAuthorizationGenerationSource, authorizeRealtimeSubscription } from '@kavaroutes/realtime';
import { createPostgresRealtimeStore } from '@kavaroutes/realtime/postgres';
import { registerWp009Realtime } from '@kavaroutes/realtime/fastify';
import { makePool, verifyRuntimeDatabase } from './database.mjs';
import { validateConfig, tenantId, branchScopeReference } from './config.mjs';

export async function createRuntimeApi(input) {
  const config = validateConfig(input);
  if (new URL(config.databaseUrl).username !== 'kr_cloud_api') throw new Error('RUNTIME_DATABASE_ROLE_INVALID');
  const pool = makePool(config);
  const verifier = createSyntheticTestVerifier();
  const application = createWp007PostgresApplication(pool, { etagSecret: config.etagSecret });
  const checkDatabase = async () => { await verifyRuntimeDatabase(pool, 'api'); await application.listTrips(tenantId, { limit: 1 }); };
  const app = await createWp007Api({ application, driverItineraryReader: createDriverItineraryReader(pool),
    browserRecoveryService:createPostgresBrowserRecoveryService(pool,{application,dispatchService:createPostgresDispatchService(pool,{etag:application.etag}),routeProposalService:createPostgresRouteProposalService(pool),driverClosureService:createPostgresDriverClosureService(pool)}),
    dispatchService: createPostgresDispatchService(pool,{etag:application.etag}),
    routeProposalService: createPostgresRouteProposalService(pool),
    facilityService:createPostgresFacilityService(pool),
    clientService:createPostgresClientService(pool),
    driverLoginService:createPostgresDriverLoginService(pool),
    driverShiftService: createPostgresDriverShiftService(pool),
    driverShiftReader: createPostgresDriverShiftStateReader(pool),
    driverActionService: createPostgresDriverActionService(pool,{etag:application.etag}),
    driverPrecheckService: createPostgresDriverPrecheckService(pool),
    driverPostcheckService: createPostgresDriverPrecheckService(pool,{stage:'POST'}),
    driverClosureService: createPostgresDriverClosureService(pool),
    driverSignatureService: createPostgresDriverSignatureService(pool,{etag:application.etag}),
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
    const closurePath=/^\/v1\/organizations\/[^/]+\/(?:(?:driver|dispatch)\/shifts\/[^/]+\/status|driver\/shifts\/[^/]+\/(?:synthetic-location-batches|commands\/(?:postcheck|close))|dispatch\/shifts\/[^/]+\/(?:return-review|commands\/override-return))$/.test(path);
    if(closurePath)return; // Authentication/capability checks remain in the registered handlers.
    if (!routeProposalPath && !/^\/(health\/ready|v1\/me|v1\/realtime|v1\/organizations\/[^/]+\/(trips(?:\/[^/]+(?:\/commands\/cancel)?)?|clients(?:\/commands\/create|\/[^/]+\/commands\/update)?|driver-logins\/(?:commands\/(?:create|verify)|[^/]+\/commands\/claim)|dispatch-board\/\d{4}-\d{2}-\d{2}|dispatch\/runs\/(?:[^/]+\/commands\/(?:assign|unassign)|commands\/plan)|driver\/(?:itineraries\/\d{4}-\d{2}-\d{2}|action-batches|shifts\/(?:commands\/start|assignments\/[^/]+|[^/]+\/(?:commands\/precheck|legs\/[^/]+\/evidence\/signatures)))|runtime-dispatch-snapshot|realtime-change-queries))$/.test(path)) {
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
