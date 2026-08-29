import { performance } from "node:perf_hooks";
import swagger from "@fastify/swagger";
import type { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import Fastify, { LogController, type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { Type as TypeBox, type Static, type TSchema } from "typebox";
import { Compile } from "typebox/compile";
import { Value } from "typebox/value";
import { PersistenceConflict } from "@kavaroutes/postgres-persistence";
import type { EffectiveDriverPolicy } from "@kavaroutes/platform-engine/domain";
import { createRegistrationService, createTokenVault, type RegistrationInput, type RegistrationInactiveReason } from "@kavaroutes/push-notifications";
import type { Wp007Application } from "./application.js";
import { createDocumentationApplication, createOfflineBatchService, syntheticReadModels } from "./application.js";
import { createSyntheticDriverPolicyService, policyVersionFromEtag, type DriverPolicyService } from "./driver-policy.js";
import { createCursorCodec, IdempotencyKeySchema, isValidTraceparent, parseStrictJson, problemFor, ProblemSchema, ProtocolError, safeTelemetryEvent, StrongEtagSchema } from "./index-internal.js";
import type { SafeTelemetryEvent } from "./protocol.js";
import { authorize, createSyntheticTestVerifier, type AuthorizationRequirement, type PrincipalVerifier, type SyntheticPrincipal, syntheticIds } from "./security.js";
import {
  allSchemas, BatchReceiptSchema, CancelTripRequestSchema, DispatchDaySchema, DispatcherTripSchema,
  DriverActionBatchSchema, DriverControlPolicySchema, DriverManifestSchema, LocationBatchSchema, MeResponseSchema, OpaqueIdSchema,
  OperationSchema, PushRegistrationRequestSchema, PushRegistrationResponseSchema, PushUnregistrationRequestSchema,
  RiderSearchRequestSchema, RiderSearchResponseSchema, ServiceDateSchema,
  TripCollectionSchema, TripCommandResponseSchema, TripCreateRequestSchema, UpdateDriverControlPolicySchema,
} from "./schemas.js";
import type { CancelTripRequest, DriverActionBatch, LocationBatch, PushRegistrationRequest, PushUnregistrationRequest, TripCreateRequest, UpdateDriverControlPolicy } from "./schemas.js";

const Type = Object.freeze({
  ...TypeBox,
  Ref<T extends TSchema>(schema: T) {
    const id = (schema as { $id?: unknown }).$id;
    if (typeof id !== "string") throw new Error("REFERENCED_SCHEMA_ID_REQUIRED");
    return TypeBox.Unsafe<Static<T>>({ $ref: id });
  },
});

interface Wp007RequestContext {
  readonly requestId: string;
  readonly startedAt: number;
  principal: SyntheticPrincipal | null;
  resultCode: string;
}

declare module "fastify" {
  interface FastifyRequest { wp007Context: Wp007RequestContext; }
}

export interface Wp007ApiOptions {
  readonly application?: Wp007Application;
  readonly verifier?: PrincipalVerifier;
  readonly cursorSecret?: string;
  readonly etagSecret?: string;
  readonly now?: () => Date;
  readonly requestIdFactory?: () => string;
  readonly telemetrySink?: (event: SafeTelemetryEvent) => void;
  readonly rateLimitPerOperation?: number;
  readonly driverPolicyService?: DriverPolicyService;
  readonly pushRegistrationService?: ReturnType<typeof createRegistrationService>;
}

const OrganizationParams = Type.Object({ organizationId: Type.Ref(OpaqueIdSchema) }, { additionalProperties: false });
const TripParams = Type.Object({ organizationId: Type.Ref(OpaqueIdSchema), tripId: Type.Ref(OpaqueIdSchema) }, { additionalProperties: false });
const DispatchDayParams = Type.Object({ organizationId: Type.Ref(OpaqueIdSchema), serviceDate: Type.Ref(ServiceDateSchema) }, { additionalProperties: false });
const OperationParams = Type.Object({ organizationId: Type.Ref(OpaqueIdSchema), operationId: Type.Ref(OpaqueIdSchema) }, { additionalProperties: false });
const InstallationParams = Type.Object({ organizationId: Type.Ref(OpaqueIdSchema), installationId: Type.Ref(OpaqueIdSchema) }, { additionalProperties: false });
const CollectionQuery = Type.Object({ cursor: Type.Optional(Type.String({ minLength: 32, maxLength: 2048 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })) }, { additionalProperties: false });
const AuthorizationHeaders = Type.Object({ authorization: Type.String({ pattern: "^Synthetic principal_[a-z_]+$", maxLength: 64 }) });
const IdempotentHeaders = Type.Intersect([AuthorizationHeaders, Type.Object({ "idempotency-key": Type.Ref(IdempotencyKeySchema) })]);
const CommandHeaders = Type.Intersect([IdempotentHeaders, Type.Object({ "if-match": Type.Optional(Type.Ref(StrongEtagSchema)) })]);
const ConditionalHeaders = Type.Intersect([AuthorizationHeaders, Type.Object({ "if-none-match": Type.Optional(Type.Ref(StrongEtagSchema)) })]);

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

function contextPrincipal(request: FastifyRequest): SyntheticPrincipal {
  const principal = request.wp007Context.principal;
  if (!principal) throw new ProtocolError(401, "AUTHENTICATION_REQUIRED", "authentication required");
  return principal;
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
  const cursorCodec = createCursorCodec(options.cursorSecret ?? "synthetic-cursor-secret-wp007-local-only");
  const offline = createOfflineBatchService(now);
  const driverPolicy = options.driverPolicyService ?? createSyntheticDriverPolicyService({ organizationId: syntheticIds.organizationA, now });
  const pushRegistrations = options.pushRegistrationService ?? createRegistrationService({ now, vault: createTokenVault({
    encryptionKey: Buffer.from("wp012-local-encryption-key-00001"), equalityKey: Buffer.from("wp012-local-equality-key-00000001"),
  }) });
  const pinnedDriverPolicy = driverPolicy.resolveShift({ organizationId: syntheticIds.organizationA, driverId: syntheticIds.driverSubject,
    assignmentId: "40000000-0000-4000-8000-000000000001", relationship: "EMPLOYEE", capabilities: new Set() });
  const rateLimit = options.rateLimitPerOperation ?? 10_000;
  const rateCounters = new Map<string, number>();
  let nextRequest = 0;
  const requestIdFactory = options.requestIdFactory ?? (() => `req_wp007_${String(++nextRequest).padStart(8, "0")}`);
  const schemaContext = Object.fromEntries(allSchemas.map((schema) => {
    const id = (schema as { $id?: unknown }).$id;
    if (typeof id !== "string") throw new Error("REGISTERED_SCHEMA_ID_REQUIRED");
    return [id, schema];
  }));
  const app = Fastify({
    logger: false, bodyLimit: 1024 * 1024, requestIdHeader: false,
    exposeHeadRoutes: false,
    genReqId: requestIdFactory, logController: new LogController({ disableRequestLogging: true }),
    ajv: { customOptions: { removeAdditional: false, coerceTypes: false, allErrors: false } },
  }).setValidatorCompiler(({ schema, httpPart }) => {
    const typeCheck = Compile(schemaContext, schema as TSchema);
    return (value) => {
      const converted = httpPart === "body" ? value : Value.Convert(schemaContext, schema as TSchema, value);
      if (typeCheck.Check(converted)) return { value: converted };
      return { error: typeCheck.Errors(converted) };
    };
  }).withTypeProvider<TypeBoxTypeProvider>();

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
      components: { securitySchemes: { syntheticTestPrincipal: { type: "apiKey", in: "header", name: "Authorization", description: "Local deterministic test verifier only; not a production authentication scheme." } } },
    },
  });
  for (const schema of allSchemas) app.addSchema(schema);
  app.decorateRequest("wp007Context");

  app.addHook("onRequest", async (request) => {
    request.wp007Context = { requestId: request.id, startedAt: performance.now(), principal: null, resultCode: "UNSET" };
    if (["POST", "PUT", "PATCH"].includes(request.method)) {
      const mediaType = request.headers["content-type"]?.split(";")[0]?.trim().toLowerCase();
      if (mediaType !== "application/json") throw new ProtocolError(415, "UNSUPPORTED_MEDIA_TYPE", "request media type unsupported");
    }
    const accept = request.headers.accept;
    if (accept && !accept.split(",").some((value) => ["*/*", "application/json"].includes(value.split(";")[0]?.trim() ?? ""))) {
      throw new ProtocolError(406, "REPRESENTATION_NOT_ACCEPTABLE", "response type not accepted");
    }
    if (request.headers.traceparent !== undefined && !isValidTraceparent(request.headers.traceparent)) {
      throw new ProtocolError(400, "TRACE_CONTEXT_INVALID", "trace context invalid");
    }
    const queryKeys = Object.keys(request.query as Record<string, unknown>);
    if (queryKeys.some((key) => /token|authorization|session|tenant|idempotency|etag/i.test(key))) {
      throw new ProtocolError(400, "SENSITIVE_QUERY_PARAMETER", "sensitive query parameter prohibited");
    }
    request.wp007Context.principal = await verifier.verify(request.headers.authorization);
    if (!request.wp007Context.principal) throw new ProtocolError(401, "AUTHENTICATION_REQUIRED", "authentication required");
  });

  app.addHook("onSend", async (request, reply, payload) => {
    if (request.url.startsWith("/v1")) reply.header("cache-control", "no-store");
    return payload;
  });
  app.addHook("onResponse", async (request, reply) => {
    options.telemetrySink?.(safeTelemetryEvent({
      operationId: request.routeOptions.schema?.operationId ?? "unmatchedRoute",
      routeTemplate: request.routeOptions.url ?? "unmatched",
      statusCode: reply.statusCode,
      elapsedMs: performance.now() - request.wp007Context.startedAt,
      resultCode: request.wp007Context.resultCode,
    }));
  });

  const requireAccess = (request: FastifyRequest, organizationId: string, requirement: AuthorizationRequirement, operationId: string) => {
    const principal = contextPrincipal(request);
    authorize(principal, organizationId, requirement);
    const key = `${organizationId}:${principal.id}:${operationId}`;
    const used = (rateCounters.get(key) ?? 0) + 1;
    rateCounters.set(key, used);
    if (used > rateLimit) throw new ProtocolError(429, "RATE_LIMIT_EXCEEDED", "rate limit exceeded", { retryAfterSeconds: 1 });
    return principal;
  };

  app.setErrorHandler((error, request, reply) => {
    const errorRecord: Record<string, unknown> = typeof error === "object" && error !== null
      ? error as unknown as Record<string, unknown>
      : {};
    const validation = Array.isArray(errorRecord.validation) ? errorRecord.validation : null;
    const pushCode = error instanceof Error && /^PUSH_[A-Z0-9_]+$/.test(error.message) ? error.message : null;
    let status = error instanceof ProtocolError ? error.statusCode
      : error instanceof PersistenceConflict
        ? ({ "stale-version": 412, "idempotency-mismatch": 422, "idempotency-in-progress": 409, "idempotency-expired": 410,
          "resource-overlap": 409, duplicate: 409, relationship: 404, tenant: 404 }[error.kind] ?? 500)
        : pushCode ? (/NOT_FOUND|CONTEXT_MISMATCH/.test(pushCode) ? 404 : 422)
        : validation ? 400
          : errorRecord.code === "FST_ERR_CTP_BODY_TOO_LARGE" ? 413
            : typeof errorRecord.statusCode === "number" ? errorRecord.statusCode : 500;
    if (!(status in errors)) status = 500;
    const code = error instanceof ProtocolError ? error.code
      : error instanceof PersistenceConflict ? `PERSISTENCE_${error.kind.replaceAll("-", "_").toUpperCase()}`
        : pushCode ?? (validation ? "REQUEST_SCHEMA_INVALID"
          : status === 413 ? "PAYLOAD_TOO_LARGE" : status === 415 ? "UNSUPPORTED_MEDIA_TYPE" : "INTERNAL_ERROR");
    const pointer = validation
      ? String((validation[0] as { instancePath?: string } | undefined)?.instancePath || "/request").replace(/[^/A-Za-z0-9_-]/g, "").slice(0, 256)
      : error instanceof ProtocolError ? error.pointer : undefined;
    request.wp007Context.resultCode = code;
    if (status === 401) reply.header("www-authenticate", "Synthetic realm=\"kavaroutes-local-test\"");
    const retryAfter = error instanceof ProtocolError ? error.retryAfterSeconds : undefined;
    if (retryAfter !== undefined && [429, 503].includes(status)) reply.header("retry-after", String(retryAfter));
    void reply.status(status).type("application/problem+json").send(problemFor({ status, requestId: request.wp007Context.requestId, code, ...(pointer ? { pointer } : {}) }));
  });
  app.setNotFoundHandler((request, reply) => {
    request.wp007Context.resultCode = "RESOURCE_NOT_FOUND";
    void reply.status(404).type("application/problem+json").send(problemFor({ status: 404, requestId: request.wp007Context.requestId }));
  });

  const security = [{ syntheticTestPrincipal: [] }];
  app.get("/v1/me", { schema: { operationId: "getMe", tags: ["profile"], security, headers: AuthorizationHeaders,
    response: responseWithErrors({ 200: jsonResponse(MeResponseSchema, "Current synthetic principal") }, [400, 401, 406, 429, 500]) } }, async (request, reply) => {
    const principal = contextPrincipal(request);
    request.wp007Context.resultCode = "PROFILE_RETURNED";
    return reply.send({ principalId: principal.id, principalKind: principal.kind,
      organizations: [{ organizationId: principal.organizationId, capabilities: [...principal.capabilities].sort() }], policyVersion: "privacy-synthetic-v1" });
  });

  app.get("/v1/organizations/:organizationId/trips", { schema: { operationId: "listTrips", tags: ["intake"], security,
    headers: AuthorizationHeaders, params: OrganizationParams, querystring: CollectionQuery,
    response: responseWithErrors({ 200: jsonResponse(TripCollectionSchema, "Cursor page", { Link: { schema: { type: "string" } } }) }, [400, 401, 404, 406, 410, 429, 500]) } }, async (request, reply) => {
    const { organizationId } = request.params as { organizationId: string };
    const principal = requireAccess(request, organizationId, { capability: "trips:read", purpose: "RIDER_INTAKE" }, "listTrips");
    const query = request.query as { cursor?: string; limit?: number };
    const limit = query.limit ?? 50;
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

  app.post("/v1/organizations/:organizationId/rider-searches", { bodyLimit: 256 * 1024, schema: { operationId: "searchRiders", tags: ["intake"], security,
    headers: AuthorizationHeaders, params: OrganizationParams, body: RiderSearchRequestSchema,
    response: responseWithErrors({ 200: jsonResponse(RiderSearchResponseSchema, "Bounded synthetic rider search") }, [400, 401, 404, 406, 413, 415, 422, 429, 500]) } }, async (request, reply) => {
    const { organizationId } = request.params as { organizationId: string };
    requireAccess(request, organizationId, { capability: "riders:read", purpose: "RIDER_INTAKE" }, "searchRiders");
    const body = request.body as { syntheticReferencePrefix: string; limit?: number };
    request.wp007Context.resultCode = "RIDER_SEARCH_RETURNED";
    return reply.send({ items: await application.searchRiders(organizationId, body.syntheticReferencePrefix, body.limit ?? 25) });
  });

  app.post("/v1/organizations/:organizationId/trips", { bodyLimit: 256 * 1024, schema: { operationId: "createTrip", tags: ["intake"], security,
    headers: IdempotentHeaders, params: OrganizationParams, body: TripCreateRequestSchema,
    response: responseWithErrors({ 201: jsonResponse(DispatcherTripSchema, "Created trip", { Location: { schema: { type: "string" } }, ETag: { schema: StrongEtagSchema }, "KavaRoutes-Idempotency-Replayed": { schema: { type: "string", enum: ["true"] } } }) }, [400, 401, 404, 406, 409, 413, 415, 422, 429, 500]) } }, async (request, reply) => {
    const { organizationId } = request.params as { organizationId: string };
    const principal = requireAccess(request, organizationId, { capability: "trips:write", purpose: "RIDER_INTAKE" }, "createTrip");
    const result = await application.createTrip({ organizationId, principal, key: String(request.headers["idempotency-key"]), request: request.body as TripCreateRequest });
    for (const [name, value] of Object.entries(result.headers)) reply.header(name, value);
    if (result.replayed) reply.header("kavaroutes-idempotency-replayed", "true");
    request.wp007Context.resultCode = result.replayed ? "IDEMPOTENT_REPLAY" : "TRIP_CREATED";
    return reply.status(201).send(result.body);
  });

  const sendTrip = async (request: FastifyRequest, reply: FastifyReply, head: boolean) => {
    const { organizationId, tripId } = request.params as { organizationId: string; tripId: string };
    requireAccess(request, organizationId, { capability: "trips:read", purpose: "RIDER_INTAKE" }, head ? "headTrip" : "getTrip");
    const trip = await application.readTrip(organizationId, tripId);
    if (!trip) throw new ProtocolError(404, "RESOURCE_NOT_FOUND", "resource hidden");
    const tag = application.etag(trip.tripId, trip.version, "dispatcher-trip-v1");
    reply.header("etag", tag);
    if (request.headers["if-none-match"] === tag) { request.wp007Context.resultCode = "NOT_MODIFIED"; return reply.status(304).send(); }
    request.wp007Context.resultCode = "TRIP_RETURNED";
    return head ? reply.status(200).send() : reply.send(trip);
  };
  app.get("/v1/organizations/:organizationId/trips/:tripId", { schema: { operationId: "getTrip", tags: ["intake"], security,
    headers: ConditionalHeaders, params: TripParams, response: responseWithErrors({ 200: jsonResponse(DispatcherTripSchema, "Dispatcher trip", { ETag: { schema: StrongEtagSchema } }), 304: { description: "Not modified" } }, [400, 401, 404, 406, 429, 500]) } }, (request, reply) => sendTrip(request, reply, false));
  app.head("/v1/organizations/:organizationId/trips/:tripId", { schema: { operationId: "headTrip", tags: ["intake"], security,
    headers: ConditionalHeaders, params: TripParams, response: responseWithErrors({ 200: { description: "Trip headers", headers: { ETag: { schema: StrongEtagSchema } } }, 304: { description: "Not modified" } }, [400, 401, 404, 406, 429, 500]) } }, (request, reply) => sendTrip(request, reply, true));

  app.post("/v1/organizations/:organizationId/trips/:tripId/commands/cancel", { bodyLimit: 256 * 1024, schema: { operationId: "cancelTrip", tags: ["intake"], security,
    headers: CommandHeaders, params: TripParams, body: CancelTripRequestSchema,
    response: responseWithErrors({ 200: jsonResponse(TripCommandResponseSchema, "Cancelled trip", { ETag: { schema: StrongEtagSchema }, "KavaRoutes-Idempotency-Replayed": { schema: { type: "string", enum: ["true"] } } }) }, [400, 401, 403, 404, 406, 409, 412, 413, 415, 422, 428, 429, 500]) } }, async (request, reply) => {
    const { organizationId, tripId } = request.params as { organizationId: string; tripId: string };
    const principal = requireAccess(request, organizationId, { capability: "trips:command", purpose: "RIDER_INTAKE", resourceIsVisible: true }, "cancelTrip");
    const ifMatch = request.headers["if-match"];
    if (typeof ifMatch !== "string") throw new ProtocolError(428, "PRECONDITION_REQUIRED", "current strong tag required");
    const result = await application.cancelTrip({ organizationId, principal, tripId, key: String(request.headers["idempotency-key"]), ifMatch, request: request.body as CancelTripRequest });
    for (const [name, value] of Object.entries(result.headers)) reply.header(name, value);
    if (result.replayed) reply.header("kavaroutes-idempotency-replayed", "true");
    request.wp007Context.resultCode = result.replayed ? "IDEMPOTENT_REPLAY" : "TRIP_CANCELLED";
    return reply.send(result.body);
  });

  app.get("/v1/organizations/:organizationId/dispatch-days/:serviceDate", { schema: { operationId: "getDispatchDay", tags: ["dispatch"], security,
    headers: ConditionalHeaders, params: DispatchDayParams, response: responseWithErrors({ 200: jsonResponse(DispatchDaySchema, "Versioned dispatch-day snapshot", { ETag: { schema: StrongEtagSchema } }), 304: { description: "Not modified" } }, [400, 401, 404, 406, 429, 500]) } }, async (request, reply) => {
    const { organizationId, serviceDate } = request.params as { organizationId: string; serviceDate: string };
    requireAccess(request, organizationId, { capability: "dispatch:read", purpose: "ASSIGNED_SERVICE_DELIVERY" }, "getDispatchDay");
    const runs = await application.readDispatchDay(organizationId, serviceDate);
    const snapshotVersion = Math.max(1, ...runs.map((run) => run.version));
    const tag = application.etag(serviceDate, snapshotVersion, "dispatch-day-v1");
    reply.header("etag", tag);
    if (request.headers["if-none-match"] === tag) { request.wp007Context.resultCode = "NOT_MODIFIED"; return reply.status(304).send(); }
    request.wp007Context.resultCode = "DISPATCH_DAY_RETURNED";
    return reply.send({ serviceDate, serviceTimezone: runs[0]?.serviceTimezone ?? "America/Los_Angeles", snapshotVersion,
      runs: runs.map(({ runId, plannedStartAt, plannedEndAt, lifecycle }) => ({ runId, plannedStartAt, plannedEndAt, lifecycle })) });
  });

  app.get("/v1/organizations/:organizationId/driver/manifest", { schema: { operationId: "getDriverManifest", tags: ["driver"], security,
    headers: ConditionalHeaders, params: OrganizationParams, response: responseWithErrors({ 200: jsonResponse(DriverManifestSchema, "Minimum-necessary driver manifest", { ETag: { schema: StrongEtagSchema } }), 304: { description: "Not modified" } }, [400, 401, 404, 406, 429, 500]) } }, async (request, reply) => {
    const { organizationId } = request.params as { organizationId: string };
    requireAccess(request, organizationId, { capability: "driver:manifest:read", purpose: "ASSIGNED_SERVICE_DELIVERY", subjectId: syntheticIds.driverSubject }, "getDriverManifest");
    const tag = application.etag(syntheticReadModels.manifest.driverReference, syntheticReadModels.manifest.version, "driver-manifest-v1");
    reply.header("etag", tag);
    if (request.headers["if-none-match"] === tag) { request.wp007Context.resultCode = "NOT_MODIFIED"; return reply.status(304).send(); }
    request.wp007Context.resultCode = "DRIVER_MANIFEST_RETURNED";
    return reply.send({ ...syntheticReadModels.manifest, effectivePolicy: pinnedDriverPolicy, effectivePolicyDigest: pinnedDriverPolicy.canonicalDigest });
  });

  app.get("/v1/organizations/:organizationId/driver-control-policy", { schema: { operationId: "getDriverControlPolicy", tags: ["driver"], security,
    headers: ConditionalHeaders, params: OrganizationParams, response: responseWithErrors({ 200: jsonResponse(DriverControlPolicySchema, "Versioned organization Driver control policy", { ETag: { schema: StrongEtagSchema } }), 304: { description: "Not modified" } }, [400, 401, 403, 404, 406, 429, 500]) } }, async (request, reply) => {
    const { organizationId } = request.params as { organizationId: string };
    requireAccess(request, organizationId, { capability: "driver-policy:read", purpose: "ASSIGNED_SERVICE_DELIVERY", resourceIsVisible: true }, "getDriverControlPolicy");
    const policy = driverPolicy.read(organizationId); if (!policy) throw new ProtocolError(404, "RESOURCE_NOT_FOUND", "resource hidden");
    const tag = application.etag(policy.organizationId, policy.version, "driver-control-policy-v1"); reply.header("etag", tag);
    if (request.headers["if-none-match"] === tag) { request.wp007Context.resultCode = "NOT_MODIFIED"; return reply.status(304).send(); }
    request.wp007Context.resultCode = "DRIVER_POLICY_RETURNED"; return reply.send(policy);
  });

  app.post("/v1/organizations/:organizationId/driver-control-policy/commands/update", { bodyLimit: 256 * 1024, schema: { operationId: "updateDriverControlPolicy", tags: ["driver"], security,
    headers: CommandHeaders, params: OrganizationParams, body: UpdateDriverControlPolicySchema,
    response: responseWithErrors({ 200: jsonResponse(DriverControlPolicySchema, "Updated organization Driver control policy", { ETag: { schema: StrongEtagSchema }, "KavaRoutes-Idempotency-Replayed": { schema: { type: "string", enum: ["true"] } } }) }, [400, 401, 403, 404, 406, 409, 412, 413, 415, 422, 428, 429, 500]) } }, async (request, reply) => {
    const { organizationId } = request.params as { organizationId: string }; const principal = contextPrincipal(request);
    const capability = principal.capabilities.has("driver-policy:write") ? "driver-policy:write" : "driver-policy:override";
    requireAccess(request, organizationId, { capability, purpose: "ASSIGNED_SERVICE_DELIVERY", resourceIsVisible: true }, "updateDriverControlPolicy");
    const ifMatch = request.headers["if-match"]; if (typeof ifMatch !== "string") throw new ProtocolError(428, "PRECONDITION_REQUIRED", "current strong tag required");
    const current = driverPolicy.read(organizationId); if (!current) throw new ProtocolError(404, "RESOURCE_NOT_FOUND", "resource hidden");
    const result = driverPolicy.update({ organizationId, principal, idempotencyKey: String(request.headers["idempotency-key"]),
      expectedVersion: () => policyVersionFromEtag(ifMatch, current, application.etag), command: request.body as UpdateDriverControlPolicy });
    reply.header("etag", application.etag(result.policy.organizationId, result.policy.version, "driver-control-policy-v1"));
    if (result.replayed) reply.header("kavaroutes-idempotency-replayed", "true");
    request.wp007Context.resultCode = result.replayed ? "IDEMPOTENT_REPLAY" : "DRIVER_POLICY_UPDATED"; return reply.send(result.policy);
  });

  app.post("/v1/organizations/:organizationId/driver/action-batches", { bodyLimit: 512 * 1024, schema: { operationId: "submitDriverActionBatch", tags: ["driver"], security,
    headers: IdempotentHeaders, params: OrganizationParams, body: DriverActionBatchSchema,
    response: responseWithErrors({ 200: jsonResponse(BatchReceiptSchema, "Ordered action receipts", { "KavaRoutes-Idempotency-Replayed": { schema: { type: "string", enum: ["true"] } } }) }, [400, 401, 404, 406, 409, 413, 415, 422, 429, 500]) } }, async (request, reply) => {
    const { organizationId } = request.params as { organizationId: string };
    const principal = requireAccess(request, organizationId, { capability: "driver:execute", purpose: "ASSIGNED_SERVICE_DELIVERY", subjectId: syntheticIds.driverSubject }, "submitDriverActionBatch");
    const result = await offline.actions(`${organizationId}:${principal.id}`, String(request.headers["idempotency-key"]), request.body as DriverActionBatch,
      (item) => policyActionRejection(item, pinnedDriverPolicy));
    if (result.replayed) reply.header("kavaroutes-idempotency-replayed", "true");
    request.wp007Context.resultCode = result.replayed ? "IDEMPOTENT_REPLAY" : "ACTION_BATCH_COMMITTED";
    return reply.send(result.receipt);
  });

  app.post("/v1/organizations/:organizationId/driver/location-batches", { bodyLimit: 1024 * 1024, schema: { operationId: "submitDriverLocationBatch", tags: ["driver"], security,
    headers: IdempotentHeaders, params: OrganizationParams, body: LocationBatchSchema,
    response: responseWithErrors({ 200: jsonResponse(BatchReceiptSchema, "Location sample receipts", { "KavaRoutes-Idempotency-Replayed": { schema: { type: "string", enum: ["true"] } } }) }, [400, 401, 404, 406, 409, 413, 415, 422, 429, 500]) } }, async (request, reply) => {
    const { organizationId } = request.params as { organizationId: string };
    const principal = requireAccess(request, organizationId, { capability: "driver:location:write", purpose: "ASSIGNED_SERVICE_DELIVERY", subjectId: syntheticIds.driverSubject }, "submitDriverLocationBatch");
    const result = await offline.locations(`${organizationId}:${principal.id}`, String(request.headers["idempotency-key"]), request.body as LocationBatch);
    if (result.replayed) reply.header("kavaroutes-idempotency-replayed", "true");
    request.wp007Context.resultCode = result.replayed ? "IDEMPOTENT_REPLAY" : "LOCATION_BATCH_COMMITTED";
    return reply.send(result.receipt);
  });

  app.post("/v1/organizations/:organizationId/driver/installations", { bodyLimit: 16 * 1024, schema: { operationId: "registerDriverInstallation", tags: ["notifications"], security,
    headers: IdempotentHeaders, params: OrganizationParams, body: PushRegistrationRequestSchema,
    response: responseWithErrors({ 200: jsonResponse(PushRegistrationResponseSchema, "Registered native push installation without returning its routing token") }, [400, 401, 404, 406, 409, 413, 415, 422, 429, 500]) } }, async (request, reply) => {
    const { organizationId } = request.params as { organizationId: string };
    const principal = requireAccess(request, organizationId, { capability: "driver:notifications:write", purpose: "ASSIGNED_SERVICE_DELIVERY", subjectId: syntheticIds.driverSubject }, "registerDriverInstallation");
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

  app.post("/v1/organizations/:organizationId/driver/installations/:installationId/commands/unregister", { bodyLimit: 8 * 1024, schema: { operationId: "unregisterDriverInstallation", tags: ["notifications"], security,
    headers: IdempotentHeaders, params: InstallationParams, body: PushUnregistrationRequestSchema,
    response: responseWithErrors({ 200: jsonResponse(PushRegistrationResponseSchema, "Disabled the exact installation generation") }, [400, 401, 404, 406, 409, 413, 415, 422, 429, 500]) } }, async (request, reply) => {
    const { organizationId, installationId } = request.params as { organizationId: string; installationId: string };
    const principal = requireAccess(request, organizationId, { capability: "driver:notifications:write", purpose: "ASSIGNED_SERVICE_DELIVERY", subjectId: syntheticIds.driverSubject }, "unregisterDriverInstallation");
    if (!principal.subjectId) throw new ProtocolError(404, "RESOURCE_NOT_FOUND", "resource hidden");
    const body = request.body as PushUnregistrationRequest;
    const unregistered = pushRegistrations.unregister({ organizationId, principalId: principal.id, subjectId: principal.subjectId },
      { installationId, generation: body.generation, reason: body.reason as RegistrationInactiveReason });
    request.wp007Context.resultCode = "PUSH_INSTALLATION_UNREGISTERED";
    return reply.send({ installationId: unregistered.installationId, generation: unregistered.generation, platform: unregistered.platform,
      provider: unregistered.provider, permission: unregistered.permission, channelEnabled: unregistered.channelEnabled,
      policyVersion: unregistered.policyVersion, lifecycle: unregistered.lifecycle, lastConfirmedAt: unregistered.lastConfirmedAt });
  });

  app.get("/v1/organizations/:organizationId/operations/:operationId", { schema: { operationId: "getOperation", tags: ["operations"], security,
    headers: AuthorizationHeaders, params: OperationParams, response: responseWithErrors({ 200: jsonResponse(OperationSchema, "Synthetic operation status") }, [400, 401, 404, 406, 410, 429, 500, 503]) } }, async (request, reply) => {
    const { organizationId, operationId } = request.params as { organizationId: string; operationId: string };
    requireAccess(request, organizationId, { capability: "integrations:read", purpose: "PARTNER_EXPORT" }, "getOperation");
    if (operationId !== syntheticReadModels.operation.operationId) throw new ProtocolError(404, "RESOURCE_NOT_FOUND", "resource hidden");
    request.wp007Context.resultCode = "OPERATION_RETURNED";
    return reply.send(syntheticReadModels.operation);
  });

  return app;
}
