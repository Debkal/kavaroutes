import { performance } from "node:perf_hooks";
import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { PersistenceConflict } from "@kavaroutes/postgres-persistence";
import type { AdmissionController } from "./admission-control.js";
import { isValidTraceparent, problemFor, ProtocolError, safeTelemetryEvent } from "./index-internal.js";
import type { SafeTelemetryEvent } from "./protocol.js";
import { authorize, type AuthorizationRequirement, type PrincipalVerifier, type SyntheticPrincipal } from "./security.js";

interface Wp007RequestContext {
  readonly requestId: string;
  readonly startedAt: number;
  principal: SyntheticPrincipal | null;
  resultCode: string;
}

declare module "fastify" {
  interface FastifyRequest { wp007Context: Wp007RequestContext; }
}

export type RequireApiAccess = (
  request: FastifyRequest,
  organizationId: string,
  requirement: AuthorizationRequirement,
  operationId: string,
) => Promise<SyntheticPrincipal>;

/** A request guard placed inside the API lifecycle scope.
 *
 * Return the reply to refuse the request; return nothing to continue. Guards run
 * after the request context exists and before authentication, so a refusal
 * short-circuits before any credential is read or any business route is
 * reached. */
export type RequestGuard = (request: FastifyRequest, reply: FastifyReply) => unknown;

export function contextPrincipal(request: FastifyRequest): SyntheticPrincipal {
  const principal = request.wp007Context.principal;
  if (!principal) throw new ProtocolError(401, "AUTHENTICATION_REQUIRED", "authentication required");
  return principal;
}

const allowedErrorStatuses = new Set([400, 401, 403, 404, 406, 409, 410, 412, 413, 415, 422, 428, 429, 500, 502, 503, 504]);

function persistenceStatus(error: PersistenceConflict): number {
  return ({ "stale-version": 412, "idempotency-mismatch": 422, "idempotency-in-progress": 409, "idempotency-expired": 410,
    "resource-overlap": 409, duplicate: 409, relationship: 404, tenant: 404 }[error.kind] ?? 500);
}

type RequestValidation = readonly { readonly instancePath?: string }[];
const errorRecord = (error: unknown): Record<string, unknown> => typeof error === "object" && error !== null ? error as Record<string, unknown> : {};
const requestValidation = (record: Record<string, unknown>): RequestValidation | null => Array.isArray(record.validation) ? record.validation as RequestValidation : null;
const pushErrorCode = (error: unknown): string | null => error instanceof Error && /^PUSH_[A-Z0-9_]+$/.test(error.message) ? error.message : null;

function candidateErrorStatus(error: unknown, record: Record<string, unknown>, validation: RequestValidation | null, pushCode: string | null): number {
  if (error instanceof ProtocolError) return error.statusCode;
  if (error instanceof PersistenceConflict) return persistenceStatus(error);
  if (pushCode) return /NOT_FOUND|CONTEXT_MISMATCH/.test(pushCode) ? 404 : 422;
  if (validation) return 400;
  if (record.code === "FST_ERR_CTP_BODY_TOO_LARGE") return 413;
  return typeof record.statusCode === "number" ? record.statusCode : 500;
}

function mappedErrorCode(error: unknown, status: number, validation: RequestValidation | null, pushCode: string | null): string {
  if (error instanceof ProtocolError) return error.code;
  if (error instanceof PersistenceConflict) return `PERSISTENCE_${error.kind.replaceAll("-", "_").toUpperCase()}`;
  if (pushCode) return pushCode;
  if (validation) return "REQUEST_SCHEMA_INVALID";
  if (status === 413) return "PAYLOAD_TOO_LARGE";
  if (status === 415) return "UNSUPPORTED_MEDIA_TYPE";
  return "INTERNAL_ERROR";
}

export function mappedError(error: unknown): { readonly status: number; readonly code: string; readonly pointer?: string; readonly retryAfterSeconds?: number } {
  const record = errorRecord(error);
  const validation = requestValidation(record);
  const pushCode = pushErrorCode(error);
  const candidateStatus = candidateErrorStatus(error, record, validation, pushCode);
  const status = allowedErrorStatuses.has(candidateStatus) ? candidateStatus : 500;
  const code = mappedErrorCode(error, status, validation, pushCode);
  const pointer = validation
    ? String(validation[0]?.instancePath || "/request").replace(/[^/A-Za-z0-9_-]/g, "").slice(0, 256)
    : error instanceof ProtocolError ? error.pointer : undefined;
  return { status, code, ...(pointer ? { pointer } : {}),
    ...(error instanceof ProtocolError && error.retryAfterSeconds !== undefined ? { retryAfterSeconds: error.retryAfterSeconds } : {}) };
}

export function createApiLifecyclePlugin(options: {
  readonly verifier: PrincipalVerifier;
  readonly admissionController: AdmissionController;
  readonly telemetrySink?: (event: SafeTelemetryEvent) => void;
  /** Ordered guards for every request in this scope, including requests that
   * match no route. They must be supplied here rather than as an outer hook: a
   * hook added to an outer instance after this plugin is created never runs for
   * these routes, so a caller that needs edge trust or a promoted-path allowlist
   * to cover the business surface has to install it in this scope. */
  readonly requestGuards?: readonly RequestGuard[];
  readonly registerRoutes: (api: FastifyInstance, requireAccess: RequireApiAccess) => Promise<void>;
}): FastifyPluginAsync {
  return async (api) => {
    api.decorateRequest("wp007Context");
    api.addHook("onRequest", async (request, reply) => {
      request.wp007Context = { requestId: request.id, startedAt: performance.now(), principal: null, resultCode: "UNSET" };
      for (const guard of options.requestGuards ?? []) {
        const refusal = await guard(request, reply);
        if (refusal !== undefined) return refusal as FastifyReply;
      }
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
      request.wp007Context.principal = options.verifier.verifyRequest
        ? await options.verifier.verifyRequest({method:request.method,headers:request.headers})
        : await options.verifier.verify(request.headers.authorization);
      if (!request.wp007Context.principal) throw new ProtocolError(401, "AUTHENTICATION_REQUIRED", "authentication required");
    });
    api.addHook("onSend", async (request, reply, payload) => {
      if (request.url.startsWith("/v1")) reply.header("cache-control", "no-store");
      return payload;
    });
    api.addHook("onResponse", async (request, reply) => {
      options.telemetrySink?.(safeTelemetryEvent({ operationId: request.routeOptions.schema?.operationId ?? "unmatchedRoute",
        routeTemplate: request.routeOptions.url ?? "unmatched", statusCode: reply.statusCode,
        elapsedMs: performance.now() - request.wp007Context.startedAt, resultCode: request.wp007Context.resultCode }));
    });

    const requireAccess: RequireApiAccess = async (request, organizationId, requirement, operationId) => {
      const principal = contextPrincipal(request);
      authorize(principal, organizationId, requirement);
      const decision = await options.admissionController.admit({ organizationId, principalId: principal.id, operationId });
      if (!decision.allowed) throw new ProtocolError(429, "RATE_LIMIT_EXCEEDED", "rate limit exceeded", { retryAfterSeconds: decision.retryAfterSeconds ?? 1 });
      return principal;
    };

    api.setErrorHandler((error, request, reply) => {
      const { status, code, pointer, retryAfterSeconds } = mappedError(error);
      request.wp007Context.resultCode = code;
      if (status === 401) reply.header("www-authenticate", "Synthetic realm=\"kavaroutes-local-test\"");
      if (retryAfterSeconds !== undefined && [429, 503].includes(status)) reply.header("retry-after", String(retryAfterSeconds));
      void reply.status(status).type("application/problem+json").send(problemFor({ status, requestId: request.wp007Context.requestId, code, ...(pointer ? { pointer } : {}) }));
    });
    api.setNotFoundHandler((request, reply) => {
      request.wp007Context.resultCode = "RESOURCE_NOT_FOUND";
      void reply.status(404).type("application/problem+json").send(problemFor({ status: 404, requestId: request.wp007Context.requestId }));
    });
    await options.registerRoutes(api, requireAccess);
  };
}
