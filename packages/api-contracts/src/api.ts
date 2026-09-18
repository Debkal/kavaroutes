import swagger from "@fastify/swagger";
import {BrowserCommandPrepareSchema,BrowserCommandViewSchema,BrowserCommandPendingSchema,type BrowserRecoveryService} from './browser-recovery.js';
import {FacilityDaySchema,type FacilityService} from './facility-day.js';
import {DriverClosureRequestSchema,DriverClosureReceiptSchema,DriverClosureViewSchema,DriverSyntheticLocationRequestSchema,DriverSyntheticLocationReceiptSchema,DriverReturnOverrideRequestSchema,DriverReturnReviewSchema,type DriverClosureService} from './driver-closure.js';
import {RouteProposalRequestSchema,RouteDecisionRequestSchema,RouteProposalReceiptSchema,RouteProposalViewSchema,type RouteProposalService} from './route-proposals.js';
import {DispatchBoardSchema,AssignDispatchRunRequestSchema,AssignDispatchRunReceiptSchema,PlanDispatchRunRequestSchema,PlanDispatchRunReceiptSchema,UnassignDispatchRunRequestSchema,UnassignDispatchRunReceiptSchema,type DispatchService,type AssignDispatchRunRequest,type PlanDispatchRunRequest,type UnassignDispatchRunRequest} from './dispatch-board.js';
import {ClientCreateRequestSchema,ClientCreateReceiptSchema,ClientRosterSchema,ClientUpdateRequestSchema,type ClientService,type ClientCreateRequest,type ClientUpdateRequest} from './client-records.js';
import {DriverAccountCreateRequestSchema,DriverAccountReceiptSchema,DriverLoginClaimRequestSchema,DriverLoginCreateRequestSchema,DriverLoginReceiptSchema,DriverLoginStateSchema,DriverLoginVerifyRequestSchema,type DriverLoginService,type DriverAccountCreateRequest,type DriverLoginCreateRequest,type DriverLoginClaimRequest,type DriverLoginVerifyRequest} from './driver-logins.js';
import type { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import Fastify, { LogController, type FastifyInstance, type FastifyPluginAsync, type FastifyReply, type FastifyRequest, type FastifyServerOptions } from "fastify";
import { Type as TypeBox, type Static, type TSchema } from "typebox";
import { Compile } from "typebox/compile";
import { Value } from "typebox/value";
import type { EffectiveDriverPolicy } from "@kavaroutes/platform-engine/domain";
import { createRegistrationService, createTokenVault, type RegistrationInput, type RegistrationInactiveReason } from "@kavaroutes/push-notifications";
import { createSyntheticLocalAdmissionController, type AdmissionController } from "./admission-control.js";
import { contextPrincipal, createApiLifecyclePlugin, type RequestGuard } from "./api-lifecycle.js";
import type { Wp007Application } from "./application.js";
import { createDocumentationApplication, createOfflineBatchService, syntheticReadModels } from "./application.js";
import { createSyntheticDriverPolicyService, policyVersionFromEtag, type DriverPolicyService } from "./driver-policy.js";
import { createCursorCodec, IdempotencyKeySchema, parseStrictJson, ProblemSchema, ProtocolError, StrongEtagSchema } from "./index-internal.js";
import type { IntegrationSecretProfile, SafeTelemetryEvent } from "./protocol.js";
import { companyBranchScope, companyFleetScope, createSyntheticTestVerifier, type PrincipalVerifier, syntheticIds } from "./security.js";
import { DriverItinerarySchema, type DriverItineraryReader } from "./driver-itinerary.js";
import type { DriverActionService } from "./driver-actions.js";
import { DriverSignatureRequestSchema,DriverSignatureReceiptSchema,type DriverSignatureService,type DriverSignatureRequest } from "./driver-service-proof.js";
import { DriverPrecheckRequestSchema, DriverPrecheckReceiptSchema, DriverShiftStateSchema, type DriverShiftReader, type DriverPrecheckService, type DriverPrecheckRequest } from "./driver-precheck.js";
import { StartDriverShiftRequestSchema, StartDriverShiftReceiptSchema, type DriverShiftService, type StartDriverShiftRequest } from "./driver-shift.js";
import {
  BatchReceiptSchema, CancelTripRequestSchema, DispatchDaySchema, DispatcherTripSchema, FacilityTripProjectionSchema,
  DriverActionBatchSchema, DriverControlPolicySchema, DriverManifestSchema, LocationBatchSchema, MeResponseSchema, OpaqueIdSchema,
  OperationSchema, PushRegistrationRequestSchema, PushRegistrationResponseSchema, PushUnregistrationRequestSchema,
  RiderSearchRequestSchema, RiderSearchResponseSchema, ServiceDateSchema,
  TripCollectionSchema, TripCommandResponseSchema, TripCreateRequestSchema, UpdateDriverControlPolicySchema,
} from "./schemas.js";
import { allSchemas } from "./schema-registry.js";
import type { CancelTripRequest, DriverActionBatch, LocationBatch, PushRegistrationRequest, PushUnregistrationRequest, TripCreateRequest, UpdateDriverControlPolicy } from "./schemas.js";
import { DispatchTrackingSchema } from "./dispatch-tracking.js";
import { ClientHistorySchema, CostProfileUpdateReceiptSchema, CostProfileUpdateRequestSchema, CostProfileViewSchema, InvoiceCreateRequestSchema,
  InvoiceForwardReceiptSchema, InvoiceForwardRequestSchema, InvoiceListSchema, InvoiceReceiptSchema, InvoiceViewSchema, ServiceDayEstimatesSchema,
  type AccountingApiService } from "./accounting.js";
import { DriverLocationBatchRequestSchema, DriverLocationReceiptSchema, type DriverLocationService } from "./driver-locations.js";
import type { DispatchTrackingReader } from "./dispatch-tracking.js";

const Type = Object.freeze({
  ...TypeBox,
  Ref<T extends TSchema>(schema: T) {
    const id = (schema as { $id?: unknown }).$id;
    if (typeof id !== "string") throw new Error("REFERENCED_SCHEMA_ID_REQUIRED");
    return TypeBox.Unsafe<Static<T>>({ $ref: id });
  },
});

export interface Wp007ApiOptions {
  readonly browserRecoveryService?:BrowserRecoveryService;
  readonly driverClosureService?:DriverClosureService;
  readonly facilityService?:FacilityService;
  readonly routeProposalService?: RouteProposalService;
  readonly dispatchService?: DispatchService;
  readonly clientService?: ClientService;
  readonly driverLoginService?: DriverLoginService;
  readonly application?: Wp007Application;
  readonly verifier?: PrincipalVerifier;
  readonly cursorSecret?: string;
  readonly etagSecret?: string;
  /** Secret profile of `cursorSecret`/`etagSecret`; defaults to the test profile. */
  readonly secretProfile?: IntegrationSecretProfile;
  /** Ordered guards installed inside the API lifecycle scope before
   * authentication, so they also cover the business routes below. */
  readonly requestGuards?: readonly RequestGuard[];
  readonly now?: () => Date;
  readonly requestIdFactory?: () => string;
  readonly telemetrySink?: (event: SafeTelemetryEvent) => void;
  readonly rateLimitPerOperation?: number;
  readonly admissionController?: AdmissionController;
  /** Optional Node HTTP server limits. Omitted (the default) keeps this factory's
   * historical behaviour, so the already-deployed synthetic profile is unchanged;
   * the reviewed guarded profile passes its reviewed limits so an exposed host
   * keeps application-level connection/frame bounds even though the edge WAF does
   * not inspect established WebSocket traffic. */
  readonly serverLimits?: {
    readonly headersTimeoutMs: number;
    readonly connectionTimeoutMs: number;
    readonly requestTimeoutMs: number;
    readonly handlerTimeoutMs: number;
    readonly keepAliveTimeoutMs: number;
    readonly maxRequestsPerSocket: number;
  };
  /** Fastify/pino logger configuration. Omitted (the default) keeps this factory
   * silent, which is what the local synthetic profiles rely on; the reviewed
   * guarded profile passes its reviewed redacting logger so rejected guarded
   * requests leave an audit trail without any request body, cookie, URL or
   * coordinate ever reaching the log. */
  readonly logger?: FastifyServerOptions["logger"];
  readonly driverPolicyService?: DriverPolicyService;
  readonly driverItineraryReader?: DriverItineraryReader;
  readonly driverShiftService?: DriverShiftService;
  readonly driverActionService?: DriverActionService;
  readonly driverPrecheckService?: DriverPrecheckService;
  readonly driverPostcheckService?: DriverPrecheckService;
  readonly driverSignatureService?: DriverSignatureService;
  readonly driverShiftReader?: DriverShiftReader;
  /** Real device positioning reported by the driver while a shift is open. */
  readonly driverLocationService?: DriverLocationService;
  /** Live driver map data for dispatch: current position, trace, lost-signal duration. */
  readonly dispatchTrackingReader?: DispatchTrackingReader;
  /** Route costing, payer invoices and client history: the money surface. */
  readonly accountingService?: AccountingApiService;
  readonly pushRegistrationService?: ReturnType<typeof createRegistrationService>;
}

const OrganizationParams = Type.Object({ organizationId: Type.Ref(OpaqueIdSchema) }, { additionalProperties: false });
const TripParams = Type.Object({ organizationId: Type.Ref(OpaqueIdSchema), tripId: Type.Ref(OpaqueIdSchema) }, { additionalProperties: false });
const DispatchDayParams = Type.Object({ organizationId: Type.Ref(OpaqueIdSchema), serviceDate: Type.Ref(ServiceDateSchema) }, { additionalProperties: false });
const OperationParams = Type.Object({ organizationId: Type.Ref(OpaqueIdSchema), operationId: Type.Ref(OpaqueIdSchema) }, { additionalProperties: false });
const InstallationParams = Type.Object({ organizationId: Type.Ref(OpaqueIdSchema), installationId: Type.Ref(OpaqueIdSchema) }, { additionalProperties: false });
const CollectionQuery = Type.Object({ cursor: Type.Optional(Type.String({ minLength: 32, maxLength: 2048 })), limit: Type.Optional(Type.String({pattern:'^(?:[1-9][0-9]?|1[0-9]{2}|200)$',maxLength:3})) }, { additionalProperties: false });

function jsonResponse(schema: TSchema, description: string, headers: Record<string, unknown> = {}) {
  return { description, headers, content: { "application/json": { schema: Type.Ref(schema) } } };
}
function problemResponse(description: string) {
  return { description, content: { "application/problem+json": { schema: Type.Ref(ProblemSchema) } } };
}
const errors = Object.freeze({
  400: problemResponse("Malformed request"), 401: problemResponse("Authentication required"), 403: problemResponse("Forbidden"),
  404: problemResponse("Not found"), 406: problemResponse("Not acceptable"), 409: problemResponse("Conflict"),
  410: problemResponse("Expired"), 412: problemResponse("Precondition failed"), 413: problemResponse("Payload too large"),
  415: problemResponse("Unsupported media type"), 422: problemResponse("Semantic validation failed"),
  428: problemResponse("Precondition required"), 429: problemResponse("Rate limited"), 500: problemResponse("Internal error"),
  502: problemResponse("Dependency failure"), 503: problemResponse("Temporarily unavailable"), 504: problemResponse("Dependency timeout"),
});

function responseWithErrors(success: Record<number, unknown>, selected: readonly number[] = Object.keys(errors).map(Number)) {
  const response: Record<number, unknown> = { ...success };
  for (const status of selected) response[status] = errors[status as keyof typeof errors];
  return response;
}

function policyActionRejection(item: DriverActionBatch["items"][number], policy: EffectiveDriverPolicy): string | undefined {
  if ("policyDigest" in item && item.policyDigest !== policy.canonicalDigest) return "STALE_POLICY_SNAPSHOT";
  if (item.command === "COMPLETE_PRECHECK" && policy.preInspection.mode === "DISABLED" && policy.startOdometer.mode === "DISABLED") return "CONTROL_DISABLED";
  if (item.command === "SKIP_PRECHECK") {
    if (policy.preInspection.mode === "DISABLED" && policy.startOdometer.mode === "DISABLED") return "CONTROL_DISABLED";
    if (policy.preInspection.mode === "REQUIRED" || policy.startOdometer.mode === "REQUIRED") return "CONTROL_REQUIRED_CANNOT_SKIP";
  }
  if (item.command === "COMPLETE_POSTCHECK" && policy.postInspection.mode === "DISABLED" && policy.endOdometer.mode === "DISABLED") return "CONTROL_DISABLED";
  if (item.command === "SKIP_POSTCHECK") {
    if (policy.postInspection.mode === "DISABLED" && policy.endOdometer.mode === "DISABLED") return "CONTROL_DISABLED";
    if (policy.postInspection.mode === "REQUIRED" || policy.endOdometer.mode === "REQUIRED") return "CONTROL_REQUIRED_CANNOT_SKIP";
  }
  if (item.command === "PROPOSE_ROUTE_CHANGE" && policy.routeChange.mode === "DISABLED") return "ROUTE_CHANGE_DISABLED";
  return undefined;
}

export async function createWp007Api(options: Wp007ApiOptions = {}): Promise<FastifyInstance> {
  const now = options.now ?? (() => new Date());
  const etagSecret = options.etagSecret ?? "synthetic-etag-secret-wp007-local-only";
  const application = options.application ?? createDocumentationApplication(etagSecret);
  const verifier = options.verifier ?? createSyntheticTestVerifier();
  const AuthorizationHeaders = verifier.verifyRequest
    ? Type.Object({cookie:Type.String({minLength:1,maxLength:4096})})
    : Type.Object({ authorization: Type.String({ pattern: "^Synthetic principal_[a-z_]+$", maxLength: 64 }) });
  const IdempotentHeaders = Type.Intersect([AuthorizationHeaders, Type.Object({ "idempotency-key": Type.Ref(IdempotencyKeySchema) })]);
  const CommandHeaders = Type.Intersect([IdempotentHeaders, Type.Object({ "if-match": Type.Optional(Type.Ref(StrongEtagSchema)) })]);
  const ConditionalHeaders = Type.Intersect([AuthorizationHeaders, Type.Object({ "if-none-match": Type.Optional(Type.Ref(StrongEtagSchema)) })]);
  const cursorCodec = createCursorCodec(options.cursorSecret ?? "synthetic-cursor-secret-wp007-local-only", options.secretProfile ?? "synthetic-test");
  const offline = createOfflineBatchService(now);
  const driverPolicy = options.driverPolicyService ?? createSyntheticDriverPolicyService({ organizationId: syntheticIds.organizationA, now });
  const pushRegistrations = options.pushRegistrationService ?? createRegistrationService({ now, vault: createTokenVault({
    encryptionKey: Buffer.from("wp012-local-encryption-key-00001"), equalityKey: Buffer.from("wp012-local-equality-key-00000001"),
  }) });
  const pinnedDriverPolicy = driverPolicy.resolveShift({ organizationId: syntheticIds.organizationA, driverId: syntheticIds.driverSubject,
    assignmentId: "40000000-0000-4000-8000-000000000001", relationship: "EMPLOYEE", capabilities: new Set() });
  if (options.admissionController && options.rateLimitPerOperation !== undefined) {
    throw new Error("ADMISSION_CONFIGURATION_AMBIGUOUS");
  }
  const admissionController = options.admissionController ?? createSyntheticLocalAdmissionController({
    ...(options.rateLimitPerOperation === undefined ? {} : { limitPerWindow: options.rateLimitPerOperation }),
    now,
  });
  let nextRequest = 0;
  const requestIdFactory = options.requestIdFactory ?? (() => `req_wp007_${String(++nextRequest).padStart(8, "0")}`);
  const schemaContext = Object.fromEntries(allSchemas.map((schema) => {
    const id = (schema as { $id?: unknown }).$id;
    if (typeof id !== "string") throw new Error("REGISTERED_SCHEMA_ID_REQUIRED");
    return [id, schema];
  }));
  const app = Fastify({
    logger: options.logger === undefined ? false : options.logger, bodyLimit: 1024 * 1024, requestIdHeader: false,
    exposeHeadRoutes: false,
    genReqId: requestIdFactory, logController: new LogController({ disableRequestLogging: true }),
    ...(options.serverLimits === undefined ? {} : {
      connectionTimeout: options.serverLimits.connectionTimeoutMs,
      requestTimeout: options.serverLimits.requestTimeoutMs,
      handlerTimeout: options.serverLimits.handlerTimeoutMs,
      keepAliveTimeout: options.serverLimits.keepAliveTimeoutMs,
      maxRequestsPerSocket: options.serverLimits.maxRequestsPerSocket,
    }),
    ajv: { customOptions: { removeAdditional: false, coerceTypes: false, allErrors: false } },
  }).setValidatorCompiler(({ schema, httpPart }) => {
    const typeCheck = Compile(schemaContext, schema as TSchema);
    return (value) => {
      const converted = httpPart === "body" ? value : Value.Convert(schemaContext, schema as TSchema, value);
      if (typeCheck.Check(converted)) return { value: converted };
      return { error: typeCheck.Errors(converted) };
    };
  }).withTypeProvider<TypeBoxTypeProvider>();

  // `headersTimeout` is a raw Node server property, not a Fastify option, so it
  // is set here the same way the WP005 host sets it.
  if (options.serverLimits !== undefined) app.server.headersTimeout = options.serverLimits.headersTimeoutMs;

  app.removeContentTypeParser("application/json");
  app.addContentTypeParser(/^application\/json(?:\s*;.*)?$/i, { parseAs: "string" }, (_request, body, done) => {
    try { done(null, parseStrictJson(typeof body === "string" ? body : body.toString("utf8"))); }
    catch (error) { done(error as Error); }
  });

  await app.register(swagger, {
    openapi: {
      openapi: "3.1.2",
      info: { title: "KavaRoutes local synthetic API contract", version: "1.0.0" },
      servers: [],
      tags: ["profile", "intake", "dispatch", "driver", "notifications", "operations"].map((name) => ({ name })),
      components: { securitySchemes: verifier.verifyRequest
        ? {browserSession:{type:'apiKey',in:'cookie',name:'__Host-kr-session',description:'Server-validated session; unsafe requests also require same-origin CSRF header.'}}
        : { syntheticTestPrincipal: { type: "apiKey", in: "header", name: "Authorization", description: "Local deterministic test verifier only; not a production authentication scheme." } } },
    },
  });
  for (const schema of allSchemas) app.addSchema(schema);
  const apiLifecyclePlugin = createApiLifecyclePlugin({ verifier, admissionController,
    ...(options.telemetrySink ? { telemetrySink: options.telemetrySink } : {}),
    ...(options.requestGuards ? { requestGuards: options.requestGuards } : {}),
    registerRoutes: async (api, requireAccess) => {
  const security = verifier.verifyRequest ? [{browserSession:[]}] : [{ syntheticTestPrincipal: [] }];
  const profileRoutes: FastifyPluginAsync = async (routes) => {
  routes.get("/v1/me", { schema: { operationId: "getMe", tags: ["profile"], security, headers: AuthorizationHeaders,
    response: responseWithErrors({ 200: jsonResponse(MeResponseSchema, "Current synthetic principal") }, [400, 401, 406, 429, 500]) } }, async (request, reply) => {
    const principal = contextPrincipal(request);
    request.wp007Context.resultCode = "PROFILE_RETURNED";
    return reply.send({ principalId: principal.id, principalKind: principal.kind,
      organizations: [{ organizationId: principal.organizationId, capabilities: [...principal.capabilities].sort() }], policyVersion: "privacy-synthetic-v1" });
  });
  };
  await api.register(profileRoutes);

  const intakeRoutes: FastifyPluginAsync = async (routes) => {
  routes.get("/v1/organizations/:organizationId/trips", { schema: { operationId: "listTrips", tags: ["intake"], security,
    headers: AuthorizationHeaders, params: OrganizationParams, querystring: CollectionQuery,
    response: responseWithErrors({ 200: jsonResponse(TripCollectionSchema, "Cursor page", { Link: { schema: { type: "string" } } }) }, [400, 401, 404, 406, 410, 429, 500]) } }, async (request, reply) => {
    const { organizationId } = request.params as { organizationId: string };
    const principal = await requireAccess(request, organizationId, { capability: "trips:read", purpose: "RIDER_INTAKE" }, "listTrips");
    const query = request.query as { cursor?: string; limit?: string };
    const limit = query.limit === undefined ? 50 : Number(query.limit);
    const expected = { organizationId, principalId: principal.id, purpose: "RIDER_INTAKE", filters: {}, sort: "tripId:asc", schemaVersion: "wp007.contract.v1" as const, policyVersion: "privacy-synthetic-v1" as const };
    const claims = query.cursor ? cursorCodec.decode(query.cursor, expected, now()) : null;
    const values = await application.listTrips(organizationId, { ...(claims ? { afterId: claims.tieBreaker } : {}), limit });
    const hasMore = values.length > limit;
    const items = values.slice(0, limit);
    const asOf = claims?.asOf ?? now().toISOString();
    const nextCursor = hasMore && items.at(-1) ? cursorCodec.encode({ ...expected, tieBreaker: items.at(-1)!.tripId, asOf, expiresAt: new Date(now().getTime() + 900_000).toISOString() }) : null;
    if (nextCursor) reply.header("link", `</v1/organizations/${organizationId}/trips?cursor=${nextCursor}&limit=${limit}>; rel="next"`);
    request.wp007Context.resultCode = "TRIP_PAGE_RETURNED";
    return reply.send({ items, page: { nextCursor, asOf, limit } });
  });

  routes.post("/v1/organizations/:organizationId/rider-searches", { bodyLimit: 256 * 1024, schema: { operationId: "searchRiders", tags: ["intake"], security,
    headers: AuthorizationHeaders, params: OrganizationParams, body: RiderSearchRequestSchema,
    response: responseWithErrors({ 200: jsonResponse(RiderSearchResponseSchema, "Bounded synthetic rider search") }, [400, 401, 404, 406, 413, 415, 422, 429, 500]) } }, async (request, reply) => {
    const { organizationId } = request.params as { organizationId: string };
    await requireAccess(request, organizationId, { capability: "riders:read", purpose: "RIDER_INTAKE" }, "searchRiders");
    const body = request.body as { syntheticReferencePrefix: string; limit?: number };
    request.wp007Context.resultCode = "RIDER_SEARCH_RETURNED";
    return reply.send({ items: await application.searchRiders(organizationId, body.syntheticReferencePrefix, body.limit ?? 25) });
  });

  routes.post("/v1/organizations/:organizationId/trips", { bodyLimit: 256 * 1024, schema: { operationId: "createTrip", tags: ["intake"], security,
    headers: IdempotentHeaders, params: OrganizationParams, body: TripCreateRequestSchema,
    response: responseWithErrors({ 201: jsonResponse(DispatcherTripSchema, "Created trip", { Location: { schema: { type: "string" } }, ETag: { schema: StrongEtagSchema }, "KavaRoutes-Idempotency-Replayed": { schema: { type: "string", enum: ["true"] } } }) }, [400, 401, 404, 406, 409, 413, 415, 422, 429, 500]) } }, async (request, reply) => {
    const { organizationId } = request.params as { organizationId: string };
    const principal = await requireAccess(request, organizationId, { capability: "trips:write", purpose: "RIDER_INTAKE" }, "createTrip");
    const result = await application.createTrip({ organizationId, principal, key: String(request.headers["idempotency-key"]), request: request.body as TripCreateRequest });
    for (const [name, value] of Object.entries(result.headers)) reply.header(name, value);
    if (result.replayed) reply.header("kavaroutes-idempotency-replayed", "true");
    request.wp007Context.resultCode = result.replayed ? "IDEMPOTENT_REPLAY" : "TRIP_CREATED";
    return reply.status(201).send(result.body);
  });

  const sendTrip = async (request: FastifyRequest, reply: FastifyReply, head: boolean) => {
    const { organizationId, tripId } = request.params as { organizationId: string; tripId: string };
    await requireAccess(request, organizationId, { capability: "trips:read", purpose: "RIDER_INTAKE" }, head ? "headTrip" : "getTrip");
    const trip = await application.readTrip(organizationId, tripId);
    if (!trip) throw new ProtocolError(404, "RESOURCE_NOT_FOUND", "resource hidden");
    const tag = application.etag(trip.tripId, trip.version, "dispatcher-trip-v1");
    reply.header("etag", tag);
    if (request.headers["if-none-match"] === tag) { request.wp007Context.resultCode = "NOT_MODIFIED"; return reply.status(304).send(); }
    request.wp007Context.resultCode = "TRIP_RETURNED";
    return head ? reply.status(200).send() : reply.send(trip);
  };
  routes.get("/v1/organizations/:organizationId/trips/:tripId", { schema: { operationId: "getTrip", tags: ["intake"], security,
    headers: ConditionalHeaders, params: TripParams, response: responseWithErrors({ 200: jsonResponse(DispatcherTripSchema, "Dispatcher trip", { ETag: { schema: StrongEtagSchema } }), 304: { description: "Not modified" } }, [400, 401, 404, 406, 429, 500]) } }, (request, reply) => sendTrip(request, reply, false));
  routes.head("/v1/organizations/:organizationId/trips/:tripId", { schema: { operationId: "headTrip", tags: ["intake"], security,
    headers: ConditionalHeaders, params: TripParams, response: responseWithErrors({ 200: { description: "Trip headers", headers: { ETag: { schema: StrongEtagSchema } } }, 304: { description: "Not modified" } }, [400, 401, 404, 406, 429, 500]) } }, (request, reply) => sendTrip(request, reply, true));

  routes.post("/v1/organizations/:organizationId/trips/:tripId/commands/cancel", { bodyLimit: 256 * 1024, schema: { operationId: "cancelTrip", tags: ["intake"], security,
    headers: CommandHeaders, params: TripParams, body: CancelTripRequestSchema,
    response: responseWithErrors({ 200: jsonResponse(TripCommandResponseSchema, "Cancelled trip", { ETag: { schema: StrongEtagSchema }, "KavaRoutes-Idempotency-Replayed": { schema: { type: "string", enum: ["true"] } } }) }, [400, 401, 403, 404, 406, 409, 412, 413, 415, 422, 428, 429, 500]) } }, async (request, reply) => {
    const { organizationId, tripId } = request.params as { organizationId: string; tripId: string };
    const principal = await requireAccess(request, organizationId, { capability: "trips:command", purpose: "RIDER_INTAKE", resourceIsVisible: true }, "cancelTrip");
    const ifMatch = request.headers["if-match"];
    if (typeof ifMatch !== "string") throw new ProtocolError(428, "PRECONDITION_REQUIRED", "current strong tag required");
    const result = await application.cancelTrip({ organizationId, principal, tripId, key: String(request.headers["idempotency-key"]), ifMatch, request: request.body as CancelTripRequest });
    for (const [name, value] of Object.entries(result.headers)) reply.header(name, value);
    if (result.replayed) reply.header("kavaroutes-idempotency-replayed", "true");
    request.wp007Context.resultCode = result.replayed ? "IDEMPOTENT_REPLAY" : "TRIP_CANCELLED";
    return reply.send(result.body);
  });
  };
  await api.register(intakeRoutes);
  await api.register(async routes=>{
    const params=Type.Object({organizationId:Type.Ref(OpaqueIdSchema),serviceDate:Type.Ref(ServiceDateSchema)},{additionalProperties:false});
    routes.get('/v1/organizations/:organizationId/facility/days/:serviceDate',{schema:{operationId:'getFacilityDay',tags:['facility'],security,headers:AuthorizationHeaders,params,querystring:Type.Object({after:Type.Optional(Type.Ref(OpaqueIdSchema)),limit:Type.Optional(Type.String({pattern:'^(?:[1-9][0-9]?|100)$',maxLength:3}))},{additionalProperties:false}),response:responseWithErrors({200:jsonResponse(FacilityDaySchema,'Facility-authorized day only')},[400,401,404,406,429,500,503])}},async(request,reply)=>{
      const {organizationId,serviceDate}=request.params as {organizationId:string;serviceDate:string},q=request.query as {after?:string;limit?:string};
      const principal=await requireAccess(request,organizationId,{capability:'facility:trip-status:read',purpose:'FACILITY_COORDINATION'},'getFacilityDay');
      if(!options.facilityService)throw new ProtocolError(503,'RUNTIME_PATH_NOT_PROMOTED','facility unavailable');
      return reply.send(await options.facilityService.day({organizationId,serviceDate,principal,limit:q.limit===undefined?100:Number(q.limit),...(q.after?{after:q.after}:{})}));
    });
    routes.get('/v1/organizations/:organizationId/facility/trips/:tripId',{schema:{operationId:'getFacilityTrip',tags:['facility'],security,headers:AuthorizationHeaders,params:Type.Object({organizationId:Type.Ref(OpaqueIdSchema),tripId:Type.Ref(OpaqueIdSchema)},{additionalProperties:false}),response:responseWithErrors({200:jsonResponse(FacilityTripProjectionSchema,'Facility-authorized trip only')},[400,401,404,406,429,500,503])}},async(request,reply)=>{
      const {organizationId,tripId}=request.params as {organizationId:string;tripId:string};const principal=await requireAccess(request,organizationId,{capability:'facility:trip-status:read',purpose:'FACILITY_COORDINATION'},'getFacilityTrip');
      if(!options.facilityService)throw new ProtocolError(503,'RUNTIME_PATH_NOT_PROMOTED','facility unavailable');
      return reply.send(await options.facilityService.trip({organizationId,tripId,principal}));
    });
  });

  await api.register(async routes=>{
    const params=Type.Object({organizationId:Type.Ref(OpaqueIdSchema),shiftId:Type.Ref(OpaqueIdSchema)},{additionalProperties:false});
    routes.get('/v1/organizations/:organizationId/dispatch/shifts/:shiftId/return-review',{schema:{operationId:'getDriverReturnReview',tags:['dispatch'],security,headers:AuthorizationHeaders,params,response:responseWithErrors({200:jsonResponse(DriverReturnReviewSchema,'Minimal authorized return exception review')},[400,401,404,406,429,500,503])}},async(request,reply)=>{
      const {organizationId,shiftId}=request.params as {organizationId:string;shiftId:string};const principal=await requireAccess(request,organizationId,{capability:'driver-policy:override',purpose:'ASSIGNED_SERVICE_DELIVERY'},'getDriverReturnReview');
      if(!options.driverClosureService)throw new ProtocolError(503,'RUNTIME_PATH_NOT_PROMOTED','review unavailable');
      return reply.send(await options.driverClosureService.review({organizationId,shiftId,principal}));
    });
    routes.post('/v1/organizations/:organizationId/dispatch/shifts/:shiftId/commands/override-return',{schema:{operationId:'overrideDriverReturn',tags:['dispatch'],security,headers:IdempotentHeaders,params,body:DriverReturnOverrideRequestSchema,response:responseWithErrors({200:jsonResponse(DriverClosureReceiptSchema,'Audited return override receipt')},[400,401,404,406,409,410,412,413,415,422,429,500,503])}},async(request,reply)=>{
      const {organizationId,shiftId}=request.params as {organizationId:string;shiftId:string};const principal=await requireAccess(request,organizationId,{capability:'driver-policy:override',purpose:'ASSIGNED_SERVICE_DELIVERY'},'overrideDriverReturn');
      if(!options.driverClosureService)throw new ProtocolError(503,'RUNTIME_PATH_NOT_PROMOTED','closure unavailable');
      const result=await options.driverClosureService.override({organizationId,shiftId,principal,key:String(request.headers['idempotency-key']),request:request.body as Static<typeof DriverReturnOverrideRequestSchema>});
      if(result.replayed)reply.header('kavaroutes-idempotency-replayed','true');request.wp007Context.resultCode='RETURN_OVERRIDE_RECORDED';return reply.send(result.body);
    });
    for(const dispatcher of [false,true])routes.get(`/v1/organizations/:organizationId/${dispatcher?'dispatch':'driver'}/shifts/:shiftId/status`,{schema:{operationId:dispatcher?'getDispatchShiftStatus':'getDriverShiftStatus',tags:['driver'],security,headers:AuthorizationHeaders,params,response:responseWithErrors({200:jsonResponse(DriverClosureViewSchema,'Persisted shift, vehicle and tracking status')},[400,401,404,406,429,500,503])}},async(request,reply)=>{
      const {organizationId,shiftId}=request.params as {organizationId:string;shiftId:string};const principal=await requireAccess(request,organizationId,{capability:dispatcher?'dispatch:location:read':'driver:execute',purpose:'ASSIGNED_SERVICE_DELIVERY'},dispatcher?'getDispatchShiftStatus':'getDriverShiftStatus');
      if(!options.driverClosureService)throw new ProtocolError(503,'RUNTIME_PATH_NOT_PROMOTED','shift closure unavailable');
      const value=await options.driverClosureService.read({organizationId,shiftId,principal,dispatcher});request.wp007Context.resultCode='SHIFT_STATUS_RETURNED';return reply.send(value);
    });
    for(const locations of [false,true])routes.post(`/v1/organizations/:organizationId/driver/shifts/:shiftId/${locations?'synthetic-location-batches':'commands/close'}`,{bodyLimit:locations?1024*1024:16384,schema:{operationId:locations?'submitDriverSyntheticLocations':'closeDriverShift',tags:['driver'],security,headers:IdempotentHeaders,params,body:locations?DriverSyntheticLocationRequestSchema:DriverClosureRequestSchema,response:responseWithErrors({200:jsonResponse(locations?DriverSyntheticLocationReceiptSchema:DriverClosureReceiptSchema,'Persisted command receipt')},[400,401,404,406,409,410,412,413,415,422,429,500,503])}},async(request,reply)=>{
      const {organizationId,shiftId}=request.params as {organizationId:string;shiftId:string};const principal=await requireAccess(request,organizationId,{capability:locations?'driver:location:write':'driver:execute',purpose:'ASSIGNED_SERVICE_DELIVERY'},locations?'submitDriverSyntheticLocations':'closeDriverShift');
      if(!options.driverClosureService)throw new ProtocolError(503,'RUNTIME_PATH_NOT_PROMOTED','shift closure unavailable');
      const input={organizationId,shiftId,principal,key:String(request.headers['idempotency-key'])};
      const result=locations?await options.driverClosureService.locations({...input,request:request.body as Static<typeof DriverSyntheticLocationRequestSchema>}):await options.driverClosureService.close({...input,request:request.body as Static<typeof DriverClosureRequestSchema>});
      if(result.replayed)reply.header('kavaroutes-idempotency-replayed','true');request.wp007Context.resultCode='SHIFT_COMMAND_RECORDED';return reply.send(result.body);
    });
  });

  const routeProposalRoutes:FastifyPluginAsync=async routes=>{
    for(const dispatcher of [false,true]){
      routes.get(`/v1/organizations/:organizationId/${dispatcher?'dispatch':'driver'}/shifts/:shiftId/route-proposals`,{schema:{operationId:dispatcher?'getDispatchRouteProposals':'getDriverRouteProposals',tags:['dispatch'],security,headers:AuthorizationHeaders,params:Type.Object({organizationId:Type.Ref(OpaqueIdSchema),shiftId:Type.Ref(OpaqueIdSchema)},{additionalProperties:false}),response:responseWithErrors({200:jsonResponse(RouteProposalViewSchema,'Scoped route plan and proposal decisions')},[400,401,404,406,409,412,422,429,500,503])}},async(request,reply)=>{
        const {organizationId,shiftId}=request.params as {organizationId:string;shiftId:string};
        const principal=await requireAccess(request,organizationId,{capability:dispatcher?'dispatch:read':'driver:manifest:read',purpose:'ASSIGNED_SERVICE_DELIVERY'},dispatcher?'getDispatchRouteProposals':'getDriverRouteProposals');
        if(!options.routeProposalService)throw new ProtocolError(503,'RUNTIME_PATH_NOT_PROMOTED','route service unavailable');
        const result=await options.routeProposalService.read({organizationId,principal,shiftId,dispatcher});
        const expectedTag=application.etag(`${organizationId}:${shiftId}`,result.runVersion,'route-shift-v1');
        reply.header('etag',expectedTag);
        request.wp007Context.resultCode='ROUTE_PROPOSALS_RETURNED';return reply.send({...result,expectedTag,proposals:result.proposals.map(p=>({...p,expectedTag:application.etag(`${organizationId}:${p.proposalId}`,result.runVersion,'route-decision-v1')}))});
      });
    }
    routes.post('/v1/organizations/:organizationId/driver/shifts/:shiftId/route-proposals',{bodyLimit:32768,schema:{operationId:'submitRouteProposal',tags:['driver'],security,headers:CommandHeaders,params:Type.Object({organizationId:Type.Ref(OpaqueIdSchema),shiftId:Type.Ref(OpaqueIdSchema)},{additionalProperties:false}),body:RouteProposalRequestSchema,response:responseWithErrors({200:jsonResponse(RouteProposalReceiptSchema,'Persisted proposal receipt')},[400,401,404,406,409,410,412,413,415,422,428,429,500,503])}},async(request,reply)=>{
      const {organizationId,shiftId}=request.params as {organizationId:string;shiftId:string};
      const principal=await requireAccess(request,organizationId,{capability:'driver:execute',purpose:'ASSIGNED_SERVICE_DELIVERY'},'submitRouteProposal');
      if(!options.routeProposalService)throw new ProtocolError(503,'RUNTIME_PATH_NOT_PROMOTED','route service unavailable');
      const tag=request.headers['if-match'];if(typeof tag!=='string')throw new ProtocolError(428,'PRECONDITION_REQUIRED','route tag required');
      if(tag!==application.etag(`${organizationId}:${shiftId}`,(request.body as Static<typeof RouteProposalRequestSchema>).expectedRunVersion,'route-shift-v1'))throw new ProtocolError(412,'PRECONDITION_FAILED','route tag mismatch');
      const result=await options.routeProposalService.submit({organizationId,principal,shiftId,key:String(request.headers['idempotency-key']),request:request.body as Static<typeof RouteProposalRequestSchema>});
      if(result.replayed)reply.header('kavaroutes-idempotency-replayed','true');request.wp007Context.resultCode='ROUTE_PROPOSAL_RECORDED';return reply.send(result.body);
    });
    routes.post('/v1/organizations/:organizationId/dispatch/route-proposals/:proposalId/commands/decide',{bodyLimit:16384,schema:{operationId:'decideRouteProposal',tags:['dispatch'],security,headers:CommandHeaders,params:Type.Object({organizationId:Type.Ref(OpaqueIdSchema),proposalId:Type.Ref(OpaqueIdSchema)},{additionalProperties:false}),body:RouteDecisionRequestSchema,response:responseWithErrors({200:jsonResponse(RouteProposalReceiptSchema,'Persisted proposal decision')},[400,401,404,406,409,410,412,413,415,422,428,429,500,503])}},async(request,reply)=>{
      const {organizationId,proposalId}=request.params as {organizationId:string;proposalId:string};
      const principal=await requireAccess(request,organizationId,{capability:'dispatch:command',purpose:'ASSIGNED_SERVICE_DELIVERY'},'decideRouteProposal');
      const tag=request.headers['if-match'];if(typeof tag!=='string')throw new ProtocolError(428,'PRECONDITION_REQUIRED','proposal tag required');
      if(tag!==application.etag(`${organizationId}:${proposalId}`,(request.body as Static<typeof RouteDecisionRequestSchema>).expectedRunVersion,'route-decision-v1'))throw new ProtocolError(412,'PRECONDITION_FAILED','proposal tag mismatch');
      if(!options.routeProposalService)throw new ProtocolError(503,'RUNTIME_PATH_NOT_PROMOTED','route service unavailable');
      const result=await options.routeProposalService.decide({organizationId,principal,proposalId,key:String(request.headers['idempotency-key']),request:request.body as Static<typeof RouteDecisionRequestSchema>});
      if(result.replayed)reply.header('kavaroutes-idempotency-replayed','true');request.wp007Context.resultCode='ROUTE_DECISION_RECORDED';return reply.send(result.body);
    });
  };await api.register(routeProposalRoutes);
  await api.register(async routes=>{
    const prefix='/v1/organizations/:organizationId/browser-commands';
    const service=()=>{if(!options.browserRecoveryService)throw new ProtocolError(503,'RUNTIME_PATH_NOT_PROMOTED','recovery unavailable');return options.browserRecoveryService;};
    const context=(request:FastifyRequest)=>({organizationId:(request.params as {organizationId:string}).organizationId,principal:contextPrincipal(request)});
    routes.get(prefix+'/pending',{schema:{operationId:'getPendingBrowserCommand',tags:['dispatch'],security,headers:AuthorizationHeaders,params:OrganizationParams,response:responseWithErrors({200:jsonResponse(BrowserCommandPendingSchema,'Current principal original command only')})}},async(request,reply)=>reply.send(await service().pending(context(request))));
    routes.post(prefix,{bodyLimit:16384,schema:{operationId:'prepareBrowserCommand',tags:['dispatch'],security,headers:IdempotentHeaders,params:OrganizationParams,body:BrowserCommandPrepareSchema,response:responseWithErrors({200:jsonResponse(BrowserCommandViewSchema,'Reserved original command; not domain acceptance')})}},async(request,reply)=>{
      const input=request.body as Static<typeof BrowserCommandPrepareSchema>;
      if(request.headers['idempotency-key']!==`browser-prepare-${input.id}`)throw new ProtocolError(422,'RECOVERY_KEY_MISMATCH','original reservation identity required');
      return reply.send(await service().prepare(context(request),input));
    });
    for(const action of ['execute','acknowledge'] as const)routes.post(prefix+`/:commandId/${action}`,{bodyLimit:1024,schema:{operationId:action==='execute'?'executeBrowserCommand':'acknowledgeBrowserCommand',tags:['dispatch'],security,headers:IdempotentHeaders,params:Type.Object({organizationId:Type.Ref(OpaqueIdSchema),commandId:Type.Ref(OpaqueIdSchema)},{additionalProperties:false}),body:Type.Object({},{additionalProperties:false}),response:responseWithErrors({200:jsonResponse(BrowserCommandViewSchema,'Stored authoritative result or acknowledgement')})}},async(request,reply)=>{
      const {commandId}=request.params as {commandId:string};
      if(request.headers['idempotency-key']!==`browser-${action}-${commandId}`)throw new ProtocolError(422,'RECOVERY_KEY_MISMATCH','original command identity required');
      return reply.send(await service()[action](context(request),commandId));
    });
  });
  const dispatchRoutes: FastifyPluginAsync = async (routes) => {
  routes.get('/v1/organizations/:organizationId/dispatch-board/:serviceDate',{schema:{operationId:'getDispatchBoard',tags:['dispatch'],security,headers:AuthorizationHeaders,params:DispatchDayParams,response:responseWithErrors({200:jsonResponse(DispatchBoardSchema,'Authorized persisted service-day board')},[400,401,404,406,429,500,503])}},async(request,reply)=>{
    const {organizationId,serviceDate}=request.params as {organizationId:string;serviceDate:string};
    const principal=await requireAccess(request,organizationId,{capability:'dispatch:read',purpose:'ASSIGNED_SERVICE_DELIVERY',branchScope:companyBranchScope(organizationId),fleetScope:companyFleetScope(organizationId)},'getDispatchBoard');
    if(!options.dispatchService)throw new ProtocolError(503,'RUNTIME_PATH_NOT_PROMOTED','persisted dispatch unavailable');
    const board=await options.dispatchService.read(organizationId,principal,serviceDate);
    request.wp007Context.resultCode='DISPATCH_BOARD_RETURNED';return reply.send(board);
  });
  routes.post('/v1/organizations/:organizationId/dispatch/runs/:runId/commands/assign',{bodyLimit:16*1024,schema:{operationId:'assignDispatchRun',tags:['dispatch'],security,headers:CommandHeaders,params:Type.Object({organizationId:Type.Ref(OpaqueIdSchema),runId:Type.Ref(OpaqueIdSchema)},{additionalProperties:false}),body:AssignDispatchRunRequestSchema,response:responseWithErrors({200:jsonResponse(AssignDispatchRunReceiptSchema,'Committed assignment receipt')},[400,401,403,404,406,409,410,412,413,415,422,428,429,500,503])}},async(request,reply)=>{
    const {organizationId,runId}=request.params as {organizationId:string;runId:string};
    const principal=await requireAccess(request,organizationId,{capability:'dispatch:command',purpose:'ASSIGNED_SERVICE_DELIVERY',branchScope:companyBranchScope(organizationId),fleetScope:companyFleetScope(organizationId)},'assignDispatchRun');
    const ifMatch=request.headers['if-match'];if(typeof ifMatch!=='string')throw new ProtocolError(428,'PRECONDITION_REQUIRED','current strong tag required');
    if(!options.dispatchService)throw new ProtocolError(503,'RUNTIME_PATH_NOT_PROMOTED','persisted dispatch unavailable');
    const result=await options.dispatchService.assign({organizationId,principal,runId,ifMatch,key:String(request.headers['idempotency-key']),request:request.body as AssignDispatchRunRequest});
    for(const[name,value]of Object.entries(result.headers))reply.header(name,value);
    if(result.replayed)reply.header('kavaroutes-idempotency-replayed','true');
    request.wp007Context.resultCode=result.replayed?'IDEMPOTENT_REPLAY':'DISPATCH_ASSIGNMENT_COMMITTED';return reply.send(result.body);
  });
  routes.post('/v1/organizations/:organizationId/dispatch/runs/:runId/commands/unassign',{bodyLimit:16*1024,schema:{operationId:'unassignDispatchRun',tags:['dispatch'],security,headers:CommandHeaders,params:Type.Object({organizationId:Type.Ref(OpaqueIdSchema),runId:Type.Ref(OpaqueIdSchema)},{additionalProperties:false}),body:UnassignDispatchRunRequestSchema,response:responseWithErrors({200:jsonResponse(UnassignDispatchRunReceiptSchema,'Released run receipt',{ETag:{schema:StrongEtagSchema}})},[400,401,403,404,406,409,410,412,413,415,422,428,429,500,503])}},async(request,reply)=>{
    const {organizationId,runId}=request.params as {organizationId:string;runId:string};
    const principal=await requireAccess(request,organizationId,{capability:'dispatch:command',purpose:'ASSIGNED_SERVICE_DELIVERY',branchScope:companyBranchScope(organizationId),fleetScope:companyFleetScope(organizationId)},'unassignDispatchRun');
    const ifMatch=request.headers['if-match'];if(typeof ifMatch!=='string')throw new ProtocolError(428,'PRECONDITION_REQUIRED','current strong tag required');
    if(!options.dispatchService)throw new ProtocolError(503,'RUNTIME_PATH_NOT_PROMOTED','persisted dispatch unavailable');
    const result=await options.dispatchService.unassign({organizationId,principal,runId,ifMatch,key:String(request.headers['idempotency-key']),request:request.body as UnassignDispatchRunRequest});
    for(const[name,value]of Object.entries(result.headers))reply.header(name,value);
    if(result.replayed)reply.header('kavaroutes-idempotency-replayed','true');
    request.wp007Context.resultCode=result.replayed?'IDEMPOTENT_REPLAY':'DISPATCH_ASSIGNMENT_RELEASED';return reply.send(result.body);
  });
  routes.post('/v1/organizations/:organizationId/dispatch/runs/commands/plan',{bodyLimit:128*1024,schema:{operationId:'planDispatchRun',tags:['dispatch'],security,headers:IdempotentHeaders,params:OrganizationParams,body:PlanDispatchRunRequestSchema,response:responseWithErrors({201:jsonResponse(PlanDispatchRunReceiptSchema,'Planned run receipt',{ETag:{schema:StrongEtagSchema},'KavaRoutes-Idempotency-Replayed':{schema:{type:'string',enum:['true']}}})},[400,401,403,404,406,409,410,412,413,415,422,428,429,500,503])}},async(request,reply)=>{
    const {organizationId}=request.params as {organizationId:string};
    const principal=await requireAccess(request,organizationId,{capability:'dispatch:command',purpose:'ASSIGNED_SERVICE_DELIVERY',branchScope:companyBranchScope(organizationId),fleetScope:companyFleetScope(organizationId)},'planDispatchRun');
    if(!options.dispatchService)throw new ProtocolError(503,'RUNTIME_PATH_NOT_PROMOTED','persisted dispatch unavailable');
    const result=await options.dispatchService.plan({organizationId,principal,key:String(request.headers['idempotency-key']),request:request.body as PlanDispatchRunRequest});
    for(const[name,value]of Object.entries(result.headers))reply.header(name,value);
    if(result.replayed)reply.header('kavaroutes-idempotency-replayed','true');
    request.wp007Context.resultCode=result.replayed?'IDEMPOTENT_REPLAY':'DISPATCH_ROUTE_PLANNED';return reply.status(201).send(result.body);
  });
  routes.post('/v1/organizations/:organizationId/fleet/drivers/commands/create',{bodyLimit:16384,schema:{operationId:'createDriverAccount',tags:['command'],security,headers:IdempotentHeaders,params:OrganizationParams,body:DriverAccountCreateRequestSchema,
    response:responseWithErrors({201:jsonResponse(DriverAccountReceiptSchema,'Created driver account; the invite code is returned once')},[400,401,403,404,406,409,410,412,413,415,422,428,429,500,503])}},async(request,reply)=>{
    const {organizationId}=request.params as {organizationId:string};
    const principal=await requireAccess(request,organizationId,{capability:'dispatch:command',purpose:'ASSIGNED_SERVICE_DELIVERY',branchScope:companyBranchScope(organizationId),fleetScope:companyFleetScope(organizationId)},'createDriverAccount');
    if(!options.driverLoginService)throw new ProtocolError(503,'RUNTIME_PATH_NOT_PROMOTED','driver accounts unavailable');
    const result=await options.driverLoginService.createAccount({organizationId,principal,key:String(request.headers['idempotency-key']),request:request.body as DriverAccountCreateRequest});
    if(result.replayed)reply.header('kavaroutes-idempotency-replayed','true');
    request.wp007Context.resultCode=result.replayed?'IDEMPOTENT_REPLAY':'DRIVER_ACCOUNT_CREATED';return reply.status(201).send(result.body);
  });
  routes.post('/v1/organizations/:organizationId/driver-logins/commands/create',{bodyLimit:16384,schema:{operationId:'createDriverLogin',tags:['dispatch'],security,headers:IdempotentHeaders,params:OrganizationParams,body:DriverLoginCreateRequestSchema,
    response:responseWithErrors({201:jsonResponse(DriverLoginReceiptSchema,'Invited driver login; the invite code is returned once')},[400,401,403,404,406,409,410,412,413,415,422,428,429,500,503])}},async(request,reply)=>{
    const {organizationId}=request.params as {organizationId:string};
    const principal=await requireAccess(request,organizationId,{capability:'dispatch:command',purpose:'ASSIGNED_SERVICE_DELIVERY',branchScope:companyBranchScope(organizationId),fleetScope:companyFleetScope(organizationId)},'createDriverLogin');
    if(!options.driverLoginService)throw new ProtocolError(503,'RUNTIME_PATH_NOT_PROMOTED','driver logins unavailable');
    const result=await options.driverLoginService.create({organizationId,principal,key:String(request.headers['idempotency-key']),request:request.body as DriverLoginCreateRequest});
    if(result.replayed)reply.header('kavaroutes-idempotency-replayed','true');
    request.wp007Context.resultCode=result.replayed?'IDEMPOTENT_REPLAY':'DRIVER_LOGIN_INVITED';return reply.status(201).send(result.body);
  });
  routes.post('/v1/organizations/:organizationId/driver-logins/:driverId/commands/claim',{bodyLimit:16384,schema:{operationId:'claimDriverLogin',tags:['driver'],security,headers:IdempotentHeaders,params:Type.Object({organizationId:Type.Ref(OpaqueIdSchema),driverId:Type.Ref(OpaqueIdSchema)},{additionalProperties:false}),body:DriverLoginClaimRequestSchema,
    response:responseWithErrors({200:jsonResponse(DriverLoginStateSchema,'Driver login claimed; the driver set this password')},[400,401,403,404,406,409,410,412,413,415,422,428,429,500,503])}},async(request,reply)=>{
    const {organizationId,driverId}=request.params as {organizationId:string;driverId:string};
    const principal=await requireAccess(request,organizationId,{capability:'driver:execute',purpose:'ASSIGNED_SERVICE_DELIVERY',subjectId:syntheticIds.driverSubject},'claimDriverLogin');
    if(!options.driverLoginService)throw new ProtocolError(503,'RUNTIME_PATH_NOT_PROMOTED','driver logins unavailable');
    const state=await options.driverLoginService.claim({organizationId,principal,driverId,key:String(request.headers['idempotency-key']),request:request.body as DriverLoginClaimRequest});
    request.wp007Context.resultCode='DRIVER_LOGIN_CLAIMED';return reply.send(state);
  });
  routes.post('/v1/organizations/:organizationId/driver-logins/commands/verify',{bodyLimit:16384,schema:{operationId:'verifyDriverLogin',tags:['driver'],security,headers:IdempotentHeaders,params:OrganizationParams,body:DriverLoginVerifyRequestSchema,
    response:responseWithErrors({200:jsonResponse(DriverLoginStateSchema,'Driver login verified for this phone')},[400,401,403,404,406,409,410,412,413,415,422,428,429,500,503])}},async(request,reply)=>{
    const {organizationId}=request.params as {organizationId:string};
    const principal=await requireAccess(request,organizationId,{capability:'driver:execute',purpose:'ASSIGNED_SERVICE_DELIVERY',subjectId:syntheticIds.driverSubject},'verifyDriverLogin');
    if(!options.driverLoginService)throw new ProtocolError(503,'RUNTIME_PATH_NOT_PROMOTED','driver logins unavailable');
    const state=await options.driverLoginService.verify({organizationId,principal,key:String(request.headers['idempotency-key']),request:request.body as DriverLoginVerifyRequest});
    request.wp007Context.resultCode='DRIVER_LOGIN_VERIFIED';return reply.send(state);
  });
  routes.get('/v1/organizations/:organizationId/clients',{schema:{operationId:'getClients',tags:['dispatch'],security,headers:AuthorizationHeaders,params:OrganizationParams,
    querystring:Type.Object({after:Type.Optional(Type.Ref(OpaqueIdSchema)),clientId:Type.Optional(Type.Ref(OpaqueIdSchema)),limit:Type.Optional(Type.String({pattern:'^(?:[1-9][0-9]?|100)$',maxLength:3}))},{additionalProperties:false}),
    response:responseWithErrors({200:jsonResponse(ClientRosterSchema,'Dispatch-authorized client roster')},[400,401,404,406,429,500,503])}},async(request,reply)=>{
    const {organizationId}=request.params as {organizationId:string},q=request.query as {after?:string;clientId?:string;limit?:string};
    const principal=await requireAccess(request,organizationId,{capability:'dispatch:read',purpose:'ASSIGNED_SERVICE_DELIVERY',branchScope:companyBranchScope(organizationId),fleetScope:companyFleetScope(organizationId)},'getClients');
    if(!options.clientService)throw new ProtocolError(503,'RUNTIME_PATH_NOT_PROMOTED','client intake unavailable');
    return reply.send(await options.clientService.read(organizationId,principal,{limit:q.limit===undefined?100:Number(q.limit),...(q.after?{after:q.after}:{}),...(q.clientId?{clientId:q.clientId}:{})}));
  });
  routes.post('/v1/organizations/:organizationId/clients/:clientId/commands/update',{bodyLimit:16384,schema:{operationId:'updateClient',tags:['dispatch'],security,headers:IdempotentHeaders,params:Type.Object({organizationId:Type.Ref(OpaqueIdSchema),clientId:Type.Ref(OpaqueIdSchema)},{additionalProperties:false}),body:ClientUpdateRequestSchema,
    response:responseWithErrors({200:jsonResponse(ClientCreateReceiptSchema,'Updated client receipt')},[400,401,403,404,406,409,410,412,413,415,422,428,429,500,503])}},async(request,reply)=>{
    const {organizationId,clientId}=request.params as {organizationId:string;clientId:string};
    const principal=await requireAccess(request,organizationId,{capability:'dispatch:command',purpose:'ASSIGNED_SERVICE_DELIVERY',branchScope:companyBranchScope(organizationId),fleetScope:companyFleetScope(organizationId)},'updateClient');
    if(!options.clientService)throw new ProtocolError(503,'RUNTIME_PATH_NOT_PROMOTED','client intake unavailable');
    const result=await options.clientService.update({organizationId,principal,clientId,key:String(request.headers['idempotency-key']),request:request.body as ClientUpdateRequest});
    for(const[name,value]of Object.entries(result.headers))reply.header(name,value);
    if(result.replayed)reply.header('kavaroutes-idempotency-replayed','true');
    request.wp007Context.resultCode=result.replayed?'IDEMPOTENT_REPLAY':'CLIENT_INTAKE_UPDATED';return reply.send(result.body);
  });
  routes.post('/v1/organizations/:organizationId/clients/commands/create',{bodyLimit:16384,schema:{operationId:'createClient',tags:['dispatch'],security,headers:IdempotentHeaders,params:OrganizationParams,body:ClientCreateRequestSchema,
    response:responseWithErrors({201:jsonResponse(ClientCreateReceiptSchema,'Created client receipt',{ETag:{schema:StrongEtagSchema},'KavaRoutes-Idempotency-Replayed':{schema:{type:'string',enum:['true']}}})},[400,401,403,404,406,409,410,412,413,415,422,428,429,500,503])}},async(request,reply)=>{
    const {organizationId}=request.params as {organizationId:string};
    const principal=await requireAccess(request,organizationId,{capability:'dispatch:command',purpose:'ASSIGNED_SERVICE_DELIVERY',branchScope:companyBranchScope(organizationId),fleetScope:companyFleetScope(organizationId)},'createClient');
    if(!options.clientService)throw new ProtocolError(503,'RUNTIME_PATH_NOT_PROMOTED','client intake unavailable');
    const result=await options.clientService.create({organizationId,principal,key:String(request.headers['idempotency-key']),request:request.body as ClientCreateRequest});
    for(const[name,value]of Object.entries(result.headers))reply.header(name,value);
    if(result.replayed)reply.header('kavaroutes-idempotency-replayed','true');
    request.wp007Context.resultCode=result.replayed?'IDEMPOTENT_REPLAY':'CLIENT_INTAKE_CREATED';return reply.status(201).send(result.body);
  });
  routes.get("/v1/organizations/:organizationId/dispatch-days/:serviceDate", { schema: { operationId: "getDispatchDay", tags: ["dispatch"], security,
    headers: ConditionalHeaders, params: DispatchDayParams, response: responseWithErrors({ 200: jsonResponse(DispatchDaySchema, "Versioned dispatch-day snapshot", { ETag: { schema: StrongEtagSchema } }), 304: { description: "Not modified" } }, [400, 401, 404, 406, 429, 500]) } }, async (request, reply) => {
    const { organizationId, serviceDate } = request.params as { organizationId: string; serviceDate: string };
    await requireAccess(request, organizationId, { capability: "dispatch:read", purpose: "ASSIGNED_SERVICE_DELIVERY" }, "getDispatchDay");
    const runs = await application.readDispatchDay(organizationId, serviceDate);
    const snapshotVersion = Math.max(1, ...runs.map((run) => run.version));
    const tag = application.etag(serviceDate, snapshotVersion, "dispatch-day-v1");
    reply.header("etag", tag);
    if (request.headers["if-none-match"] === tag) { request.wp007Context.resultCode = "NOT_MODIFIED"; return reply.status(304).send(); }
    request.wp007Context.resultCode = "DISPATCH_DAY_RETURNED";
    return reply.send({ serviceDate, serviceTimezone: runs[0]?.serviceTimezone ?? "America/Los_Angeles", snapshotVersion,
      runs: runs.map(({ runId, plannedStartAt, plannedEndAt, lifecycle }) => ({ runId, plannedStartAt, plannedEndAt, lifecycle })) });
  });
  };
  await api.register(dispatchRoutes);

  const driverRoutes: FastifyPluginAsync = async (routes) => {
  routes.post("/v1/organizations/:organizationId/driver/shifts/commands/start", { bodyLimit: 16 * 1024, schema: {
    operationId: "startDriverShift", tags: ["driver"], security, headers: IdempotentHeaders, params: OrganizationParams,
    body: StartDriverShiftRequestSchema,
    response: responseWithErrors({ 200: jsonResponse(StartDriverShiftReceiptSchema, "Persisted idempotent Driver shift receipt",
      { "KavaRoutes-Idempotency-Replayed": { schema: { type: "string", enum: ["true"] } } }) }, [400, 401, 404, 406, 409, 410, 413, 415, 422, 429, 500, 503]),
  } }, async (request, reply) => {
    const { organizationId } = request.params as { organizationId: string };
    const principal = await requireAccess(request, organizationId, { capability: "driver:execute", purpose: "ASSIGNED_SERVICE_DELIVERY", subjectId: syntheticIds.driverSubject }, "startDriverShift");
    if (!options.driverShiftService) throw new ProtocolError(503, "RUNTIME_PATH_NOT_PROMOTED", "persisted shift service unavailable");
    const result = await options.driverShiftService.start({ organizationId, principal,
      key: String(request.headers["idempotency-key"]), request: request.body as StartDriverShiftRequest });
    if (result.replayed) reply.header("kavaroutes-idempotency-replayed", "true");
    request.wp007Context.resultCode = result.replayed ? "IDEMPOTENT_REPLAY" : "DRIVER_SHIFT_STARTED";
    return reply.send(result.body);
  });
  for(const post of [false,true])routes.post(`/v1/organizations/:organizationId/driver/shifts/:shiftId/commands/${post?'postcheck':'precheck'}`, { bodyLimit: 512 * 1024, schema: {
    operationId: post?'submitDriverPostcheck':"submitDriverPrecheck", tags: ["driver"], security, headers: IdempotentHeaders,
    params: Type.Object({ organizationId: Type.Ref(OpaqueIdSchema), shiftId: Type.Ref(OpaqueIdSchema) }, { additionalProperties: false }),
    body: DriverPrecheckRequestSchema,
    response: responseWithErrors({ 200: jsonResponse(DriverPrecheckReceiptSchema, "Committed vehicle control decision") }, [400, 401, 404, 406, 409, 412, 413, 415, 422, 429, 500, 503]),
  } }, async (request, reply) => {
    const { organizationId, shiftId } = request.params as { organizationId: string; shiftId: string };
    const principal = contextPrincipal(request);
    if (!principal.subjectId) throw new ProtocolError(404, "RESOURCE_NOT_FOUND", "resource hidden");
    await requireAccess(request, organizationId, { capability: "driver:execute", purpose: "ASSIGNED_SERVICE_DELIVERY", subjectId: principal.subjectId }, post?'submitDriverPostcheck':"submitDriverPrecheck");
    const service=post?options.driverPostcheckService:options.driverPrecheckService;
    if (!service) throw new ProtocolError(503, "RUNTIME_PATH_NOT_PROMOTED", "persisted vehicle check service unavailable");
    const result = await service.submit({ organizationId, shiftId, principal,
      key: String(request.headers["idempotency-key"]), request: request.body as DriverPrecheckRequest });
    if (result.replayed) reply.header("kavaroutes-idempotency-replayed", "true");
    request.wp007Context.resultCode = result.replayed ? "IDEMPOTENT_REPLAY" : "DRIVER_PRECHECK_RECORDED";
    return reply.send(result.body);
  });
  routes.post("/v1/organizations/:organizationId/driver/shifts/:shiftId/legs/:legId/evidence/signatures",{ bodyLimit: 64*1024,schema: {
    operationId: "submitDriverSignature",tags: ["driver"],security,headers: IdempotentHeaders,
    params: Type.Object({ organizationId: Type.Ref(OpaqueIdSchema),shiftId: Type.Ref(OpaqueIdSchema),legId: Type.Ref(OpaqueIdSchema) },{ additionalProperties: false }),
    body: DriverSignatureRequestSchema,response: responseWithErrors({ 200: jsonResponse(DriverSignatureReceiptSchema,"Stored service proof; not billing verification") },[400,401,404,406,409,412,413,415,422,429,500,503]),
  } },async(request,reply)=>{
    const { organizationId,shiftId,legId }=request.params as { organizationId: string;shiftId: string;legId: string };const principal=contextPrincipal(request);
    if(!principal.subjectId) throw new ProtocolError(404,"RESOURCE_NOT_FOUND","resource hidden");
    await requireAccess(request,organizationId,{ capability: "driver:execute",purpose: "ASSIGNED_SERVICE_DELIVERY",subjectId: principal.subjectId },"submitDriverSignature");
    if(!options.driverSignatureService) throw new ProtocolError(503,"RUNTIME_PATH_NOT_PROMOTED","persisted signature service unavailable");
    const result=await options.driverSignatureService.submit({ organizationId,shiftId,legId,principal,key: String(request.headers["idempotency-key"]),request: request.body as DriverSignatureRequest });
    if(result.replayed) reply.header("kavaroutes-idempotency-replayed","true");request.wp007Context.resultCode=result.replayed ? "IDEMPOTENT_REPLAY" : "DRIVER_SERVICE_PROOF_RECORDED";
    return reply.send(result.body);
  });
  routes.get("/v1/organizations/:organizationId/billing/cost-profile", { schema: {
    operationId: "getRouteCostProfile", tags: ["billing"], security, headers: AuthorizationHeaders, params: OrganizationParams,
    querystring: Type.Object({}, { additionalProperties: false }),
    response: responseWithErrors({ 200: jsonResponse(CostProfileViewSchema, "Stored route costing profile, null before it is set") }, [400, 401, 403, 404, 406, 429, 500, 503]),
  } }, async (request, reply) => {
    const { organizationId } = request.params as { organizationId: string };
    await requireAccess(request, organizationId, { capability: "billing:read", purpose: "BILLING_PROOF" }, "getRouteCostProfile");
    if (!options.accountingService) throw new ProtocolError(503, "RUNTIME_PATH_NOT_PROMOTED", "accounting unavailable");
    request.wp007Context.resultCode = "ROUTE_COST_PROFILE_RETURNED";
    return reply.send(await options.accountingService.costProfile(contextPrincipal(request), organizationId));
  });
  routes.post("/v1/organizations/:organizationId/billing/cost-profile/commands/update", { bodyLimit: 16384, schema: {
    operationId: "updateRouteCostProfile", tags: ["billing"], security, headers: IdempotentHeaders, params: OrganizationParams,
    body: CostProfileUpdateRequestSchema,
    response: responseWithErrors({ 200: jsonResponse(CostProfileUpdateReceiptSchema, "Stored route costing profile version") }, [400, 401, 403, 404, 406, 409, 412, 413, 415, 422, 429, 500, 503]),
  } }, async (request, reply) => {
    const { organizationId } = request.params as { organizationId: string };
    await requireAccess(request, organizationId, { capability: "billing:command", purpose: "BILLING_PROOF" }, "updateRouteCostProfile");
    if (!options.accountingService) throw new ProtocolError(503, "RUNTIME_PATH_NOT_PROMOTED", "accounting unavailable");
    request.wp007Context.resultCode = "ROUTE_COST_PROFILE_UPDATED";
    return reply.send(await options.accountingService.updateCostProfile(contextPrincipal(request), organizationId, request.body as Static<typeof CostProfileUpdateRequestSchema>));
  });
  routes.get("/v1/organizations/:organizationId/billing/estimates/:serviceDate", { schema: {
    operationId: "getServiceDayEstimates", tags: ["billing"], security, headers: AuthorizationHeaders, params: DispatchDayParams,
    querystring: Type.Object({}, { additionalProperties: false }),
    response: responseWithErrors({ 200: jsonResponse(ServiceDayEstimatesSchema, "Costing inputs for the service day's trips") }, [400, 401, 403, 404, 406, 429, 500, 503]),
  } }, async (request, reply) => {
    const { organizationId, serviceDate } = request.params as { organizationId: string; serviceDate: string };
    await requireAccess(request, organizationId, { capability: "billing:read", purpose: "BILLING_PROOF" }, "getServiceDayEstimates");
    if (!options.accountingService) throw new ProtocolError(503, "RUNTIME_PATH_NOT_PROMOTED", "accounting unavailable");
    request.wp007Context.resultCode = "SERVICE_DAY_ESTIMATES_RETURNED";
    return reply.send(await options.accountingService.estimates(contextPrincipal(request), organizationId, serviceDate));
  });
  routes.get("/v1/organizations/:organizationId/billing/invoices", { schema: {
    operationId: "listPayerInvoices", tags: ["billing"], security, headers: AuthorizationHeaders, params: OrganizationParams,
    querystring: Type.Object({ limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })) }, { additionalProperties: false }),
    response: responseWithErrors({ 200: jsonResponse(InvoiceListSchema, "Stored payer invoices") }, [400, 401, 403, 404, 406, 429, 500, 503]),
  } }, async (request, reply) => {
    const { organizationId } = request.params as { organizationId: string };
    await requireAccess(request, organizationId, { capability: "billing:read", purpose: "BILLING_PROOF" }, "listPayerInvoices");
    if (!options.accountingService) throw new ProtocolError(503, "RUNTIME_PATH_NOT_PROMOTED", "accounting unavailable");
    const { limit } = request.query as { limit?: number };
    request.wp007Context.resultCode = "PAYER_INVOICES_RETURNED";
    return reply.send(await options.accountingService.invoices(contextPrincipal(request), organizationId, limit ?? 50));
  });
  routes.get("/v1/organizations/:organizationId/billing/invoices/:invoiceId", { schema: {
    operationId: "getPayerInvoice", tags: ["billing"], security, headers: AuthorizationHeaders,
    params: Type.Object({ organizationId: Type.Ref(OpaqueIdSchema), invoiceId: Type.Ref(OpaqueIdSchema) }, { additionalProperties: false }),
    querystring: Type.Object({}, { additionalProperties: false }),
    response: responseWithErrors({ 200: jsonResponse(InvoiceViewSchema, "Stored invoice with the trips it bills") }, [400, 401, 403, 404, 406, 429, 500, 503]),
  } }, async (request, reply) => {
    const { organizationId, invoiceId } = request.params as { organizationId: string; invoiceId: string };
    await requireAccess(request, organizationId, { capability: "billing:read", purpose: "BILLING_PROOF" }, "getPayerInvoice");
    if (!options.accountingService) throw new ProtocolError(503, "RUNTIME_PATH_NOT_PROMOTED", "accounting unavailable");
    request.wp007Context.resultCode = "PAYER_INVOICE_RETURNED";
    return reply.send(await options.accountingService.invoice(contextPrincipal(request), organizationId, invoiceId));
  });
  routes.post("/v1/organizations/:organizationId/billing/invoices/commands/create", { bodyLimit: 16384, schema: {
    operationId: "createPayerInvoice", tags: ["billing"], security, headers: IdempotentHeaders, params: OrganizationParams,
    body: InvoiceCreateRequestSchema,
    response: responseWithErrors({ 200: jsonResponse(InvoiceReceiptSchema, "Invoice created from delivered trips") }, [400, 401, 403, 404, 406, 409, 410, 412, 413, 415, 422, 429, 500, 503]),
  } }, async (request, reply) => {
    const { organizationId } = request.params as { organizationId: string };
    await requireAccess(request, organizationId, { capability: "billing:command", purpose: "BILLING_PROOF" }, "createPayerInvoice");
    if (!options.accountingService) throw new ProtocolError(503, "RUNTIME_PATH_NOT_PROMOTED", "accounting unavailable");
    request.wp007Context.resultCode = "PAYER_INVOICE_CREATED";
    return reply.send(await options.accountingService.createInvoice(contextPrincipal(request), organizationId, request.body as Static<typeof InvoiceCreateRequestSchema>));
  });
  routes.post("/v1/organizations/:organizationId/billing/invoices/:invoiceId/commands/forward", { bodyLimit: 8192, schema: {
    operationId: "forwardPayerInvoice", tags: ["billing"], security, headers: IdempotentHeaders,
    params: Type.Object({ organizationId: Type.Ref(OpaqueIdSchema), invoiceId: Type.Ref(OpaqueIdSchema) }, { additionalProperties: false }),
    body: InvoiceForwardRequestSchema,
    response: responseWithErrors({ 200: jsonResponse(InvoiceForwardReceiptSchema, "Invoice forwarding recorded") }, [400, 401, 403, 404, 406, 409, 410, 412, 413, 415, 422, 429, 500, 503]),
  } }, async (request, reply) => {
    const { organizationId, invoiceId } = request.params as { organizationId: string; invoiceId: string };
    await requireAccess(request, organizationId, { capability: "billing:command", purpose: "BILLING_PROOF" }, "forwardPayerInvoice");
    if (!options.accountingService) throw new ProtocolError(503, "RUNTIME_PATH_NOT_PROMOTED", "accounting unavailable");
    request.wp007Context.resultCode = "PAYER_INVOICE_FORWARDED";
    return reply.send(await options.accountingService.forwardInvoice(contextPrincipal(request), organizationId, invoiceId, request.body as Static<typeof InvoiceForwardRequestSchema>));
  });
  routes.post("/v1/organizations/:organizationId/driver/shifts/:shiftId/location-batches", { bodyLimit: 256 * 1024, schema: {
    operationId: "submitDriverShiftLocationBatch", tags: ["driver"], security, headers: IdempotentHeaders,
    params: Type.Object({ organizationId: Type.Ref(OpaqueIdSchema), shiftId: Type.Ref(OpaqueIdSchema) }, { additionalProperties: false }),
    body: DriverLocationBatchRequestSchema,
    response: responseWithErrors({ 200: jsonResponse(DriverLocationReceiptSchema, "Persisted device location batch") }, [400, 401, 403, 404, 406, 409, 410, 412, 413, 415, 422, 429, 500, 503]),
  } }, async (request, reply) => {
    const { organizationId, shiftId } = request.params as { organizationId: string; shiftId: string };
    const context = contextPrincipal(request);
    if (!context.subjectId) throw new ProtocolError(404, "RESOURCE_NOT_FOUND", "resource hidden");
    const principal = await requireAccess(request, organizationId, { capability: "driver:location:write",
      purpose: "ASSIGNED_SERVICE_DELIVERY", subjectId: context.subjectId }, "submitDriverShiftLocationBatch");
    if (!options.driverLocationService) throw new ProtocolError(503, "RUNTIME_PATH_NOT_PROMOTED", "device location unavailable");
    const result = await options.driverLocationService.submit({ organizationId, principal, shiftId, key: String(request.headers["idempotency-key"]),
      request: request.body as Static<typeof DriverLocationBatchRequestSchema> });
    for (const [name, value] of Object.entries(result.headers)) reply.header(name, value);
    if (result.replayed) reply.header("kavaroutes-idempotency-replayed", "true");
    request.wp007Context.resultCode = result.replayed ? "IDEMPOTENT_REPLAY" : "DRIVER_LOCATION_BATCH_STORED";
    return reply.send(result.body);
  });
  routes.get("/v1/organizations/:organizationId/clients/:clientId/history", { schema: {
    operationId: "getClientRouteHistory", tags: ["billing"], security, headers: AuthorizationHeaders,
    params: Type.Object({ organizationId: Type.Ref(OpaqueIdSchema), clientId: Type.Ref(OpaqueIdSchema) }, { additionalProperties: false }),
    querystring: Type.Object({ days: Type.Optional(Type.Integer({ minimum: 1, maximum: 3650 })) }, { additionalProperties: false }),
    response: responseWithErrors({ 200: jsonResponse(ClientHistorySchema, "A client's route history over the chosen lookback") }, [400, 401, 403, 404, 406, 429, 500, 503]),
  } }, async (request, reply) => {
    const { organizationId, clientId } = request.params as { organizationId: string; clientId: string };
    await requireAccess(request, organizationId, { capability: "billing:read", purpose: "BILLING_PROOF" }, "getClientRouteHistory");
    if (!options.accountingService) throw new ProtocolError(503, "RUNTIME_PATH_NOT_PROMOTED", "accounting unavailable");
    const { days } = request.query as { days?: number };
    request.wp007Context.resultCode = "CLIENT_ROUTE_HISTORY_RETURNED";
    return reply.send(await options.accountingService.clientHistory(contextPrincipal(request), organizationId, clientId, days ?? 90));
  });
  routes.get("/v1/organizations/:organizationId/dispatch/tracking/:serviceDate", { schema: {
    operationId: "getDispatchTracking", tags: ["dispatch"], security, headers: AuthorizationHeaders, params: DispatchDayParams,
    querystring: Type.Object({}, { additionalProperties: false }),
    response: responseWithErrors({ 200: jsonResponse(DispatchTrackingSchema, "Authorized live driver tracking for the service day") }, [400, 401, 403, 404, 406, 429, 500, 503]),
  } }, async (request, reply) => {
    const { organizationId, serviceDate } = request.params as { organizationId: string; serviceDate: string };
    await requireAccess(request, organizationId, { capability: "dispatch:read", purpose: "ASSIGNED_SERVICE_DELIVERY",
      branchScope: companyBranchScope(organizationId), fleetScope: companyFleetScope(organizationId) }, "getDispatchTracking");
    if (!options.dispatchTrackingReader) throw new ProtocolError(503, "RUNTIME_PATH_NOT_PROMOTED", "dispatch tracking unavailable");
    const tracking = await options.dispatchTrackingReader(organizationId, serviceDate);
    request.wp007Context.resultCode = "DISPATCH_TRACKING_RETURNED";
    return reply.send(tracking);
  });
  routes.get("/v1/organizations/:organizationId/driver/shifts/assignments/:assignmentId", { schema: {
    operationId: "getDriverShiftState", tags: ["driver"], security, headers: AuthorizationHeaders,
    params: Type.Object({ organizationId: Type.Ref(OpaqueIdSchema), assignmentId: Type.Ref(OpaqueIdSchema) }, { additionalProperties: false }),
    querystring: Type.Object({}, { additionalProperties: false }),
    response: responseWithErrors({ 200: jsonResponse(DriverShiftStateSchema, "Persisted shift and control receipt") }, [400, 401, 404, 406, 429, 500, 503]),
  } }, async (request, reply) => {
    const { organizationId, assignmentId } = request.params as { organizationId: string; assignmentId: string };
    const principal = contextPrincipal(request);
    if (!principal.subjectId) throw new ProtocolError(404, "RESOURCE_NOT_FOUND", "resource hidden");
    await requireAccess(request, organizationId, { capability: "driver:manifest:read", purpose: "ASSIGNED_SERVICE_DELIVERY", subjectId: principal.subjectId }, "getDriverShiftState");
    if (!options.driverShiftReader) throw new ProtocolError(503, "RUNTIME_PATH_NOT_PROMOTED", "persisted shift reader unavailable");
    const state = await options.driverShiftReader(organizationId, principal.subjectId, assignmentId);
    if (!state) throw new ProtocolError(404, "RESOURCE_NOT_FOUND", "resource hidden");
    request.wp007Context.resultCode = "DRIVER_SHIFT_READ";
    return reply.send(state);
  });
  routes.get("/v1/organizations/:organizationId/driver/itineraries/:serviceDate", { schema: {
    operationId: "getDriverItinerary", tags: ["driver"], security, headers: AuthorizationHeaders, params: DispatchDayParams,
    querystring: Type.Object({}, { additionalProperties: false }),
    response: responseWithErrors({ 200: jsonResponse(DriverItinerarySchema, "Persisted subject-scoped Driver itinerary") }, [400, 401, 404, 406, 429, 500, 503]),
  } }, async (request, reply) => {
    const { organizationId, serviceDate } = request.params as { organizationId: string; serviceDate: string };
    const principal = contextPrincipal(request);
    if (!principal.subjectId) throw new ProtocolError(404, "RESOURCE_NOT_FOUND", "resource hidden");
    await requireAccess(request, organizationId, { capability: "driver:manifest:read", purpose: "ASSIGNED_SERVICE_DELIVERY", subjectId: principal.subjectId }, "getDriverItinerary");
    if (!options.driverItineraryReader) throw new ProtocolError(503, "RUNTIME_PATH_NOT_PROMOTED", "persisted itinerary unavailable");
    const legs = await options.driverItineraryReader(organizationId, principal.subjectId, serviceDate);
    reply.header("cache-control", "no-store");
    request.wp007Context.resultCode = "DRIVER_ITINERARY_RETURNED";
    return reply.send({ driverReference: principal.subjectId, serviceDate, legs: legs.map(leg => ({ ...leg,
      ...(leg.execution ? { execution: { ...leg.execution, expectedTag: application.etag(leg.execution.executionId, leg.execution.version, "driver-execution-v1") } } : {}),
    })) });
  });
  routes.get("/v1/organizations/:organizationId/driver/manifest", { schema: { operationId: "getDriverManifest", tags: ["driver"], security,
    headers: ConditionalHeaders, params: OrganizationParams, response: responseWithErrors({ 200: jsonResponse(DriverManifestSchema, "Minimum-necessary driver manifest", { ETag: { schema: StrongEtagSchema } }), 304: { description: "Not modified" } }, [400, 401, 404, 406, 429, 500]) } }, async (request, reply) => {
    const { organizationId } = request.params as { organizationId: string };
    await requireAccess(request, organizationId, { capability: "driver:manifest:read", purpose: "ASSIGNED_SERVICE_DELIVERY", subjectId: syntheticIds.driverSubject }, "getDriverManifest");
    const tag = application.etag(syntheticReadModels.manifest.driverReference, syntheticReadModels.manifest.version, "driver-manifest-v1");
    reply.header("etag", tag);
    if (request.headers["if-none-match"] === tag) { request.wp007Context.resultCode = "NOT_MODIFIED"; return reply.status(304).send(); }
    request.wp007Context.resultCode = "DRIVER_MANIFEST_RETURNED";
    return reply.send({ ...syntheticReadModels.manifest, effectivePolicy: pinnedDriverPolicy, effectivePolicyDigest: pinnedDriverPolicy.canonicalDigest });
  });

  routes.get("/v1/organizations/:organizationId/driver-control-policy", { schema: { operationId: "getDriverControlPolicy", tags: ["driver"], security,
    headers: ConditionalHeaders, params: OrganizationParams, response: responseWithErrors({ 200: jsonResponse(DriverControlPolicySchema, "Versioned organization Driver control policy", { ETag: { schema: StrongEtagSchema } }), 304: { description: "Not modified" } }, [400, 401, 403, 404, 406, 429, 500]) } }, async (request, reply) => {
    const { organizationId } = request.params as { organizationId: string };
    await requireAccess(request, organizationId, { capability: "driver-policy:read", purpose: "ASSIGNED_SERVICE_DELIVERY", resourceIsVisible: true }, "getDriverControlPolicy");
    const policy = driverPolicy.read(organizationId); if (!policy) throw new ProtocolError(404, "RESOURCE_NOT_FOUND", "resource hidden");
    const tag = application.etag(policy.organizationId, policy.version, "driver-control-policy-v1"); reply.header("etag", tag);
    if (request.headers["if-none-match"] === tag) { request.wp007Context.resultCode = "NOT_MODIFIED"; return reply.status(304).send(); }
    request.wp007Context.resultCode = "DRIVER_POLICY_RETURNED"; return reply.send(policy);
  });

  routes.post("/v1/organizations/:organizationId/driver-control-policy/commands/update", { bodyLimit: 256 * 1024, schema: { operationId: "updateDriverControlPolicy", tags: ["driver"], security,
    headers: CommandHeaders, params: OrganizationParams, body: UpdateDriverControlPolicySchema,
    response: responseWithErrors({ 200: jsonResponse(DriverControlPolicySchema, "Updated organization Driver control policy", { ETag: { schema: StrongEtagSchema }, "KavaRoutes-Idempotency-Replayed": { schema: { type: "string", enum: ["true"] } } }) }, [400, 401, 403, 404, 406, 409, 412, 413, 415, 422, 428, 429, 500]) } }, async (request, reply) => {
    const { organizationId } = request.params as { organizationId: string }; const principal = contextPrincipal(request);
    const capability = principal.capabilities.has("driver-policy:write") ? "driver-policy:write" : "driver-policy:override";
    await requireAccess(request, organizationId, { capability, purpose: "ASSIGNED_SERVICE_DELIVERY", resourceIsVisible: true }, "updateDriverControlPolicy");
    const ifMatch = request.headers["if-match"]; if (typeof ifMatch !== "string") throw new ProtocolError(428, "PRECONDITION_REQUIRED", "current strong tag required");
    const current = driverPolicy.read(organizationId); if (!current) throw new ProtocolError(404, "RESOURCE_NOT_FOUND", "resource hidden");
    const result = driverPolicy.update({ organizationId, principal, idempotencyKey: String(request.headers["idempotency-key"]),
      expectedVersion: () => policyVersionFromEtag(ifMatch, current, application.etag), command: request.body as UpdateDriverControlPolicy });
    reply.header("etag", application.etag(result.policy.organizationId, result.policy.version, "driver-control-policy-v1"));
    if (result.replayed) reply.header("kavaroutes-idempotency-replayed", "true");
    request.wp007Context.resultCode = result.replayed ? "IDEMPOTENT_REPLAY" : "DRIVER_POLICY_UPDATED"; return reply.send(result.policy);
  });

  routes.post("/v1/organizations/:organizationId/driver/action-batches", { bodyLimit: 512 * 1024, schema: { operationId: "submitDriverActionBatch", tags: ["driver"], security,
    headers: IdempotentHeaders, params: OrganizationParams, body: DriverActionBatchSchema,
    response: responseWithErrors({ 200: jsonResponse(BatchReceiptSchema, "Ordered action receipts", { "KavaRoutes-Idempotency-Replayed": { schema: { type: "string", enum: ["true"] } } }) }, [400, 401, 404, 406, 409, 413, 415, 422, 429, 500, 503]) } }, async (request, reply) => {
    const { organizationId } = request.params as { organizationId: string };
    const principal = await requireAccess(request, organizationId, { capability: "driver:execute", purpose: "ASSIGNED_SERVICE_DELIVERY", subjectId: syntheticIds.driverSubject }, "submitDriverActionBatch");
    if (options.driverActionService) {
      const result = await options.driverActionService.submit({ organizationId, principal,
        key: String(request.headers["idempotency-key"]), request: request.body as DriverActionBatch });
      if (result.replayed) reply.header("kavaroutes-idempotency-replayed", "true");
      request.wp007Context.resultCode = result.replayed ? "IDEMPOTENT_REPLAY" : "ACTION_BATCH_COMMITTED";
      return reply.send(result.body);
    }
    if ((request.body as DriverActionBatch).shiftReference || (request.body as DriverActionBatch).shiftGeneration) {
      throw new ProtocolError(503, "RUNTIME_PATH_NOT_PROMOTED", "persisted action service unavailable");
    }
    const result = await offline.actions(`${organizationId}:${principal.id}`, String(request.headers["idempotency-key"]), request.body as DriverActionBatch,
      (item) => policyActionRejection(item, pinnedDriverPolicy));
    if (result.replayed) reply.header("kavaroutes-idempotency-replayed", "true");
    request.wp007Context.resultCode = result.replayed ? "IDEMPOTENT_REPLAY" : "ACTION_BATCH_COMMITTED";
    return reply.send(result.receipt);
  });

  routes.post("/v1/organizations/:organizationId/driver/location-batches", { bodyLimit: 1024 * 1024, schema: { operationId: "submitDriverLocationBatch", tags: ["driver"], security,
    headers: IdempotentHeaders, params: OrganizationParams, body: LocationBatchSchema,
    response: responseWithErrors({ 200: jsonResponse(BatchReceiptSchema, "Location sample receipts", { "KavaRoutes-Idempotency-Replayed": { schema: { type: "string", enum: ["true"] } } }) }, [400, 401, 404, 406, 409, 413, 415, 422, 429, 500]) } }, async (request, reply) => {
    const { organizationId } = request.params as { organizationId: string };
    const principal = await requireAccess(request, organizationId, { capability: "driver:location:write", purpose: "ASSIGNED_SERVICE_DELIVERY", subjectId: syntheticIds.driverSubject }, "submitDriverLocationBatch");
    const result = await offline.locations(`${organizationId}:${principal.id}`, String(request.headers["idempotency-key"]), request.body as LocationBatch);
    if (result.replayed) reply.header("kavaroutes-idempotency-replayed", "true");
    request.wp007Context.resultCode = result.replayed ? "IDEMPOTENT_REPLAY" : "LOCATION_BATCH_COMMITTED";
    return reply.send(result.receipt);
  });
  };
  await api.register(driverRoutes);

  const notificationRoutes: FastifyPluginAsync = async (routes) => {
  routes.post("/v1/organizations/:organizationId/driver/installations", { bodyLimit: 16 * 1024, schema: { operationId: "registerDriverInstallation", tags: ["notifications"], security,
    headers: IdempotentHeaders, params: OrganizationParams, body: PushRegistrationRequestSchema,
    response: responseWithErrors({ 200: jsonResponse(PushRegistrationResponseSchema, "Registered native push installation without returning its routing token") }, [400, 401, 404, 406, 409, 413, 415, 422, 429, 500]) } }, async (request, reply) => {
    const { organizationId } = request.params as { organizationId: string };
    const principal = await requireAccess(request, organizationId, { capability: "driver:notifications:write", purpose: "ASSIGNED_SERVICE_DELIVERY", subjectId: syntheticIds.driverSubject }, "registerDriverInstallation");
    if (!principal.subjectId) throw new ProtocolError(404, "RESOURCE_NOT_FOUND", "resource hidden");
    const body = request.body as PushRegistrationRequest;
    const input: RegistrationInput = { organizationId, principalId: principal.id, subjectId: principal.subjectId,
      installationId: body.installationId, generation: body.generation, platform: body.platform, provider: body.provider,
      environment: body.environment, appId: body.appId, token: body.nativeToken, permission: body.permission,
      channelEnabled: body.channelEnabled, policyVersion: "push.policy.v1" };
    const registered = pushRegistrations.register({ organizationId, principalId: principal.id, subjectId: principal.subjectId,
      idempotencyKey: String(request.headers["idempotency-key"]) }, input);
    request.wp007Context.resultCode = "PUSH_INSTALLATION_REGISTERED";
    return reply.send({ installationId: registered.installationId, generation: registered.generation, platform: registered.platform,
      provider: registered.provider, permission: registered.permission, channelEnabled: registered.channelEnabled,
      policyVersion: registered.policyVersion, lifecycle: registered.lifecycle, lastConfirmedAt: registered.lastConfirmedAt });
  });

  routes.post("/v1/organizations/:organizationId/driver/installations/:installationId/commands/unregister", { bodyLimit: 8 * 1024, schema: { operationId: "unregisterDriverInstallation", tags: ["notifications"], security,
    headers: IdempotentHeaders, params: InstallationParams, body: PushUnregistrationRequestSchema,
    response: responseWithErrors({ 200: jsonResponse(PushRegistrationResponseSchema, "Disabled the exact installation generation") }, [400, 401, 404, 406, 409, 413, 415, 422, 429, 500]) } }, async (request, reply) => {
    const { organizationId, installationId } = request.params as { organizationId: string; installationId: string };
    const principal = await requireAccess(request, organizationId, { capability: "driver:notifications:write", purpose: "ASSIGNED_SERVICE_DELIVERY", subjectId: syntheticIds.driverSubject }, "unregisterDriverInstallation");
    if (!principal.subjectId) throw new ProtocolError(404, "RESOURCE_NOT_FOUND", "resource hidden");
    const body = request.body as PushUnregistrationRequest;
    const unregistered = pushRegistrations.unregister({ organizationId, principalId: principal.id, subjectId: principal.subjectId },
      { installationId, generation: body.generation, reason: body.reason as RegistrationInactiveReason });
    request.wp007Context.resultCode = "PUSH_INSTALLATION_UNREGISTERED";
    return reply.send({ installationId: unregistered.installationId, generation: unregistered.generation, platform: unregistered.platform,
      provider: unregistered.provider, permission: unregistered.permission, channelEnabled: unregistered.channelEnabled,
      policyVersion: unregistered.policyVersion, lifecycle: unregistered.lifecycle, lastConfirmedAt: unregistered.lastConfirmedAt });
  });
  };
  await api.register(notificationRoutes);

  const operationRoutes: FastifyPluginAsync = async (routes) => {
  routes.get("/v1/organizations/:organizationId/operations/:operationId", { schema: { operationId: "getOperation", tags: ["operations"], security,
    headers: AuthorizationHeaders, params: OperationParams, response: responseWithErrors({ 200: jsonResponse(OperationSchema, "Synthetic operation status") }, [400, 401, 404, 406, 410, 429, 500, 503]) } }, async (request, reply) => {
    const { organizationId, operationId } = request.params as { organizationId: string; operationId: string };
    await requireAccess(request, organizationId, { capability: "integrations:read", purpose: "PARTNER_EXPORT" }, "getOperation");
    if (operationId !== syntheticReadModels.operation.operationId) throw new ProtocolError(404, "RESOURCE_NOT_FOUND", "resource hidden");
    request.wp007Context.resultCode = "OPERATION_RETURNED";
    return reply.send(syntheticReadModels.operation);
  });
  };
  await api.register(operationRoutes);
    },
  });
  await app.register(apiLifecyclePlugin);

  return app;
}
