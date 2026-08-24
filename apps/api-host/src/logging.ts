import type { LoggerOptions } from "pino";

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
