import websocket from "@fastify/websocket";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { WebSocket } from "ws";
import { problemFor, ProblemSchema, type SyntheticPrincipal } from "@kavaroutes/api-contracts";
import { ChangeQueryRequestSchema, ChangeQueryResponseSchema, REALTIME_LIMITS, REALTIME_PROTOCOL, RealtimeProtocolError, type ChangeQueryRequest } from "./contracts.js";
import { authorizeRealtimeSubscription, type AuthorizationGenerationSource, RealtimeAuthorizationDenied } from "./authorization.js";
import { createRealtimeGateway, realtimeOriginAllowedFor } from "./gateway.js";
import type { RealtimeStore } from "./store.js";
import type { RealtimeTelemetryEvent } from "./telemetry.js";

function principalFor(request: FastifyRequest): SyntheticPrincipal {
  const principal = (request as unknown as { wp007Context?: { principal: SyntheticPrincipal | null } }).wp007Context?.principal;
  if (!principal) throw new RealtimeAuthorizationDenied("ORGANIZATION_DENIED");
  return principal;
}

export async function registerWp009Realtime(app: FastifyInstance, options: {
  readonly store: RealtimeStore;
  readonly generationSource: AuthorizationGenerationSource;
  readonly allowedOrigins?: ReadonlySet<string>;
  readonly maximumConnections?: number;
  readonly now?: () => Date;
  readonly telemetrySink?: (event: RealtimeTelemetryEvent) => void;
}) {
  const allowedOrigins = options.allowedOrigins ?? new Set(["http://kavaroutes.test"]);
  const gateway = createRealtimeGateway({ ...options, allowedOrigins });
  await app.register(async (scope) => {
    await scope.register(websocket, { options: { maxPayload: REALTIME_LIMITS.maximumInboundBytes, perMessageDeflate: false,
      handleProtocols: (protocols) => protocols.has(REALTIME_PROTOCOL) && protocols.size === 1 ? REALTIME_PROTOCOL : false } });

    scope.post("/v1/organizations/:organizationId/realtime-change-queries", {
      schema: {
        operationId: "queryRealtimeChanges", tags: ["realtime"], security: [{ syntheticTestPrincipal: [] }],
        params: { type: "object", required: ["organizationId"], properties: { organizationId: { type: "string", format: "uuid" } }, additionalProperties: false },
        body: ChangeQueryRequestSchema,
        response: { 200: ChangeQueryResponseSchema, 404: ProblemSchema },
      },
    }, async (request, reply) => {
      const organizationId = (request.params as { organizationId: string }).organizationId;
      const principal = principalFor(request);
      const body = request.body as ChangeQueryRequest;
      let authorization;
      try {
        authorization = authorizeRealtimeSubscription({ principal, organizationId,
          authorizationGeneration: options.generationSource.current(principal.id), purpose: body.purpose, scope: body.scope });
      } catch (error) {
        if (error instanceof RealtimeAuthorizationDenied) return reply.code(404).type("application/problem+json").send(problemFor({ status: 404, requestId: request.id, code: "RESOURCE_NOT_FOUND" }));
        throw error;
      }
      const result = await options.store.replay(authorization, body.cursor, body.limit);
      reply.header("cache-control", "no-store");
      return result;
    });

    scope.get("/v1/realtime", {
      websocket: true,
      schema: {},
      preValidation: async (request, reply) => {
        const protocols = request.headers["sec-websocket-protocol"];
        if (protocols !== REALTIME_PROTOCOL) return reply.code(400).send({ code: "REALTIME_PROTOCOL_REQUIRED" });
        if (request.headers["x-synthetic-client-class"] !== undefined) return reply.code(400).send({ code: "REALTIME_CLIENT_CLASS_HEADER_PROHIBITED" });
        const origin = typeof request.headers.origin === "string" ? request.headers.origin : undefined;
        if (!realtimeOriginAllowedFor(principalFor(request), origin, allowedOrigins)) return reply.code(403).send({ code: "REALTIME_ORIGIN_DENIED" });
        if (Object.keys(request.query as Record<string, unknown>).length > 0) return reply.code(400).send({ code: "REALTIME_QUERY_PROHIBITED" });
      },
    }, (socket: WebSocket, request) => {
      let connectionId: string;
      try {
        connectionId = gateway.open({ principal: principalFor(request), origin: request.headers.origin,
          protocol: request.headers["sec-websocket-protocol"],
          transport: {
            get bufferedAmount() { return socket.bufferedAmount; },
            send: (text) => socket.send(text), ping: () => socket.ping(),
            close: (code, reason) => socket.close(code, reason), terminate: () => socket.terminate(),
          } });
      } catch (error) {
        const code = error instanceof RealtimeProtocolError && error.code === "RATE_LIMITED" ? 1013 : 1008;
        socket.close(code, code === 1013 ? "TRY_AGAIN_LATER" : "POLICY_VIOLATION");
        return;
      }
      socket.on("message", (data, binary) => {
        void gateway.receive(connectionId, Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer), binary)
          .catch(() => gateway.close(connectionId));
      });
      socket.on("pong", () => gateway.observeHeartbeat(connectionId));
      socket.on("error", () => gateway.close(connectionId));
      socket.on("close", () => gateway.close(connectionId));
    });
  });
  return gateway;
}
