import { randomUUID } from "node:crypto";
import swagger from "@fastify/swagger";
import { TypeBoxValidatorCompiler } from "@fastify/type-provider-typebox";
import type { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import websocket from "@fastify/websocket";
import Fastify, { LogController, type FastifyInstance, type FastifyServerOptions } from "fastify";
import type { ProbeDependencies } from "@kavaroutes/platform-engine/application";
import { createSubmitSyntheticProbe } from "@kavaroutes/platform-engine/application";
import { createMemoryAdapters } from "@kavaroutes/platform-engine/adapters";
import { createRequestContext, type RequestContext } from "@kavaroutes/shared-kernel";
import {
  HealthSchema,
  ProbeRequestSchema,
  ProbeResponseSchema,
  ReadinessSchema,
  SafeErrorSchema
} from "@kavaroutes/transport-schemas";
import type { ProbeRequest, SocketNotification } from "@kavaroutes/transport-schemas";
export { createWp007Api } from "@kavaroutes/api-contracts";

declare module "fastify" {
  interface FastifyRequest { wp005Context: RequestContext; }
}

export interface ApiFactoryOptions {
  readonly dependencies?: ProbeDependencies;
  readonly logger?: FastifyServerOptions["logger"];
  readonly operationIdFactory?: () => string;
}

function defaultOperationId(): string {
  return `op_${randomUUID().replaceAll("-", "").slice(0, 24)}`;
}

export async function createApi(options: ApiFactoryOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: options.logger === undefined ? false : options.logger,
    bodyLimit: 16 * 1024,
    requestIdHeader: false,
    logController: new LogController({ disableRequestLogging: true })
  }).setValidatorCompiler(TypeBoxValidatorCompiler).withTypeProvider<TypeBoxTypeProvider>();

  await app.register(swagger, {
    openapi: {
      info: { title: "KavaRoutes WP005 platform compatibility API", version: "0.0.0-wp005" },
      tags: [{ name: "platform", description: "Synthetic compatibility surface; not a business API" }]
    },
    transformObject: (document) => {
      const specification = "openapiObject" in document ? document.openapiObject : document.swaggerObject;
      return {
        ...specification,
        "x-kavaroutes-websocket-routes": [{
          path: "/platform/v1/socket-probe",
          purpose: "synthetic lifecycle compatibility only",
          contextHeader: "x-synthetic-context",
          maxPayloadBytes: 1024,
          messageSchema: "SocketNotification"
        }]
      };
    }
  });
  await app.register(websocket, { options: { maxPayload: 1024 } });

  app.decorateRequest("wp005Context");
  app.addHook("onRequest", async (request) => {
    request.wp005Context = createRequestContext({
      operationId: (options.operationIdFactory ?? defaultOperationId)(),
      tenantPlaceholder: "tenant_synthetic",
      actorPlaceholder: "actor_unauthenticated",
      purposePlaceholder: "purpose_compatibility",
      correlationId: "corr_synthetic"
    });
  });

  app.setErrorHandler((error, request, reply) => {
    const statusCode = typeof error === "object" && error !== null && "statusCode" in error && typeof error.statusCode === "number"
      ? error.statusCode
      : 500;
    const code = typeof error === "object" && error !== null && "validation" in error
      ? "VALIDATION_FAILED"
      : statusCode === 413
        ? "PAYLOAD_TOO_LARGE"
        : statusCode >= 400 && statusCode < 500
          ? "MALFORMED_REQUEST"
          : "INTERNAL_ERROR";
    request.log.warn({ operationId: request.wp005Context.operationId, code }, "request rejected");
    void reply.status(statusCode >= 400 && statusCode < 600 ? statusCode : 500).send({ code, operationId: request.wp005Context.operationId });
  });

  app.get("/platform/v1/health", {
    schema: { tags: ["platform"], response: { 200: HealthSchema } }
  }, async () => ({ status: "ok" as const, version: "wp005.synthetic.v1" as const }));

  app.get("/platform/v1/readiness", {
    schema: { tags: ["platform"], response: { 200: ReadinessSchema } }
  }, async () => ({ status: "ready" as const, checks: { engine: true } }));

  const submit = createSubmitSyntheticProbe(options.dependencies ?? createMemoryAdapters());
  app.post("/platform/v1/synthetic-probe", {
    schema: {
      tags: ["platform"],
      body: ProbeRequestSchema,
      response: { 202: ProbeResponseSchema, 400: SafeErrorSchema, 500: SafeErrorSchema }
    }
  }, async (request, reply) => {
    const result = await submit(request.wp005Context, request.body as ProbeRequest);
    return reply.status(202).send({
      probeId: result.probe.id,
      outcome: result.probe.outcome,
      jobId: result.jobId,
      operationId: request.wp005Context.operationId
    });
  });

  app.get("/platform/v1/socket-probe", {
    websocket: true,
    schema: {
      tags: ["platform"],
      headers: {
        type: "object",
        required: ["x-synthetic-context"],
        properties: { "x-synthetic-context": { const: "accepted" } }
      },
      response: { 400: SafeErrorSchema }
    }
  }, (socket, request) => {
    socket.send(JSON.stringify({
      type: "wp005.synthetic.notification",
      operationId: request.wp005Context.operationId,
      sequence: 1
    } satisfies SocketNotification));
    socket.on("message", () => socket.close(1008, "messages_not_supported"));
  });

  return app;
}
