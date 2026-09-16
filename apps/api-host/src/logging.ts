import type { LoggerOptions } from "pino";

export interface SafeLogEvent {
  readonly event: string;
  readonly outcome: "accepted" | "rejected" | "completed" | "failed";
  readonly statusCode?: number;
  readonly durationBucket?: "lt10ms" | "lt100ms" | "lt1000ms" | "gte1000ms";
}

const safeLabel = /^[a-z][a-z0-9_.-]{0,63}$/;

export function safeLogEvent(input: SafeLogEvent): SafeLogEvent {
  if (!safeLabel.test(input.event)) throw new Error("SAFE_LOG_EVENT_INVALID");
  if (!["accepted", "rejected", "completed", "failed"].includes(input.outcome)) throw new Error("SAFE_LOG_OUTCOME_INVALID");
  if (input.statusCode !== undefined && (!Number.isInteger(input.statusCode) || input.statusCode < 100 || input.statusCode > 599)) throw new Error("SAFE_LOG_STATUS_INVALID");
  if (input.durationBucket !== undefined && !["lt10ms", "lt100ms", "lt1000ms", "gte1000ms"].includes(input.durationBucket)) throw new Error("SAFE_LOG_DURATION_INVALID");
  return Object.freeze({ event: input.event, outcome: input.outcome,
    ...(input.statusCode === undefined ? {} : { statusCode: input.statusCode }),
    ...(input.durationBucket === undefined ? {} : { durationBucket: input.durationBucket }) });
}

export const safePinoOptions: LoggerOptions = Object.freeze({
  level: "info",
  base: null,
  redact: {
    paths: [
      "req.headers.authorization",
      "req.headers.cookie",
      "req.headers['set-cookie']",
      "request.body",
      "request.query",
      "body",
      "query",
      "headers",
      "url",
      "rawUrl",
      "cursor",
      "token",
      "payload",
      "address",
      "coordinates",
      "identity",
      "contact",
      "phone",
      "email",
      "signature",
      "secret"
    ],
    censor: "[REDACTED]"
  },
  serializers: {
    req: (request: { id?: unknown; method?: unknown; routeOptions?: { url?: unknown } }) => ({
      id: typeof request.id === "string" ? request.id : undefined,
      method: typeof request.method === "string" ? request.method : undefined,
      route: typeof request.routeOptions?.url === "string" ? request.routeOptions.url : undefined
    }),
    err: (error: { code?: unknown; name?: unknown }) => ({
      code: typeof error.code === "string" ? error.code : "UNCLASSIFIED_ERROR",
      name: typeof error.name === "string" ? error.name : "Error"
    })
  }
});
