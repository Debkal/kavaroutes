import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { Problem } from "./schemas.js";

export class ProtocolError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly pointer: string | undefined;
  readonly retryAfterSeconds: number | undefined;
  constructor(statusCode: number, code: string, message: string, options: { pointer?: string; retryAfterSeconds?: number } = {}) {
    super(message);
    this.name = "ProtocolError";
    this.statusCode = statusCode;
    this.code = code;
    this.pointer = options.pointer;
    this.retryAfterSeconds = options.retryAfterSeconds;
  }
}

export const problemRegistry = Object.freeze({
  400: ["malformed-request", "Malformed request", "MALFORMED_REQUEST"],
  401: ["authentication-required", "Authentication required", "AUTHENTICATION_REQUIRED"],
  403: ["action-forbidden", "Action forbidden", "ACTION_FORBIDDEN"],
  404: ["resource-not-found", "Resource not found", "RESOURCE_NOT_FOUND"],
  406: ["representation-not-acceptable", "Representation not acceptable", "REPRESENTATION_NOT_ACCEPTABLE"],
  408: ["request-timeout", "Request timed out", "REQUEST_TIMEOUT"],
  409: ["resource-conflict", "Resource conflict", "RESOURCE_CONFLICT"],
  410: ["resource-expired", "Resource expired", "RESOURCE_EXPIRED"],
  412: ["precondition-failed", "Precondition failed", "PRECONDITION_FAILED"],
  413: ["payload-too-large", "Payload too large", "PAYLOAD_TOO_LARGE"],
  415: ["unsupported-media-type", "Unsupported media type", "UNSUPPORTED_MEDIA_TYPE"],
  422: ["semantic-validation-failed", "Semantic validation failed", "SEMANTIC_VALIDATION_FAILED"],
  428: ["precondition-required", "Precondition required", "PRECONDITION_REQUIRED"],
  429: ["rate-limit-exceeded", "Rate limit exceeded", "RATE_LIMIT_EXCEEDED"],
  500: ["internal-error", "Internal error", "INTERNAL_ERROR"],
  502: ["dependency-failure", "Dependency failure", "DEPENDENCY_FAILURE"],
  503: ["temporarily-unavailable", "Temporarily unavailable", "TEMPORARILY_UNAVAILABLE"],
  504: ["dependency-timeout", "Dependency timeout", "DEPENDENCY_TIMEOUT"],
} as const);

export function problemFor(input: { status: number; requestId: string; code?: string; pointer?: string }): Problem {
  const registered = problemRegistry[input.status as keyof typeof problemRegistry] ?? problemRegistry[500];
  return {
    type: `urn:kavaroutes:problem:${registered[0]}`,
    title: registered[1],
    status: input.status in problemRegistry ? input.status : 500,
    detail: safeDetail(input.status),
    instance: `urn:kavaroutes:request:${input.requestId}`,
    code: input.code ?? registered[2],
    requestId: input.requestId,
    ...(input.pointer ? { errors: [{ code: input.code ?? registered[2], pointer: input.pointer }] } : {}),
  };
}

function safeDetail(status: number): string {
  if (status === 401) return "Provide the required synthetic test authentication context.";
  if (status === 404) return "The requested resource is unavailable.";
  if (status === 412 || status === 428) return "Refresh the representation and retry with its current strong tag.";
  if (status === 409) return "Resolve the current resource state before retrying.";
  if (status === 410) return "Restart from the documented collection or operation entry point.";
  if (status === 413) return "Reduce the request body or item count to the documented limit.";
  if (status >= 500) return "The request could not be completed safely.";
  return "Correct the request using the documented contract.";
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical((value as Record<string, unknown>)[key])]));
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonical(value));
}

export function requestFingerprint(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function strongEtag(secret: string, resourceId: string, version: number, projection: string): string {
  const digest = createHmac("sha256", secret).update(`${resourceId}\u0000${version}\u0000${projection}`).digest("base64url");
  return `"kr1.${digest}"`;
}

export interface CursorClaims {
  readonly organizationId: string;
  readonly principalId: string;
  readonly purpose: string;
  readonly filters: Readonly<Record<string, string>>;
  readonly sort: string;
  readonly tieBreaker: string;
  readonly schemaVersion: "wp007.contract.v1";
  readonly policyVersion: "privacy-synthetic-v1";
  readonly asOf: string;
  readonly expiresAt: string;
}

export function createCursorCodec(secret: string) {
  if (!/^synthetic-cursor-secret-[A-Za-z0-9_-]{16,}$/.test(secret)) throw new Error("TEST_CURSOR_SECRET_REQUIRED");
  return Object.freeze({
    encode(claims: CursorClaims): string {
      const payload = Buffer.from(canonicalJson(claims)).toString("base64url");
      const signature = createHmac("sha256", secret).update(payload).digest("base64url");
      return `${payload}.${signature}`;
    },
    decode(value: string, expected: Omit<CursorClaims, "tieBreaker" | "asOf" | "expiresAt">, now: Date): CursorClaims {
      if (value.length > 2048) throw new ProtocolError(400, "CURSOR_INVALID", "cursor invalid");
      const [payload, signature, extra] = value.split(".");
      if (!payload || !signature || extra) throw new ProtocolError(400, "CURSOR_INVALID", "cursor invalid");
      const actual = Buffer.from(signature);
      const wanted = Buffer.from(createHmac("sha256", secret).update(payload).digest("base64url"));
      if (actual.length !== wanted.length || !timingSafeEqual(actual, wanted)) throw new ProtocolError(400, "CURSOR_INVALID", "cursor invalid");
      let claims: CursorClaims;
      try { claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as CursorClaims; }
      catch { throw new ProtocolError(400, "CURSOR_INVALID", "cursor invalid"); }
      for (const key of ["organizationId", "principalId", "purpose", "sort", "schemaVersion", "policyVersion"] as const) {
        if (canonicalJson(claims[key]) !== canonicalJson(expected[key])) throw new ProtocolError(400, "CURSOR_SCOPE_MISMATCH", "cursor scope mismatch");
      }
      if (canonicalJson(claims.filters) !== canonicalJson(expected.filters)) throw new ProtocolError(400, "CURSOR_SCOPE_MISMATCH", "cursor scope mismatch");
      if (!Number.isFinite(Date.parse(claims.expiresAt)) || new Date(claims.expiresAt) <= now) throw new ProtocolError(410, "CURSOR_EXPIRED", "cursor expired");
      return claims;
    },
  });
}

export function isValidTraceparent(value: unknown): boolean {
  return typeof value === "string" && /^(?!ff)[0-9a-f]{2}-(?!0{32})[0-9a-f]{32}-(?!0{16})[0-9a-f]{16}-[0-9a-f]{2}$/.test(value);
}

export function parseStrictJson(raw: string, maximumDepth = 16): unknown {
  let index = 0;
  const malformed = (): never => { throw new ProtocolError(400, "MALFORMED_JSON", "malformed JSON"); };
  const whitespace = () => { while (/\s/.test(raw[index] ?? "")) index += 1; };
  const readString = (): string => {
    const start = index;
    if (raw[index] !== '"') return malformed();
    index += 1;
    while (index < raw.length) {
      if (raw[index] === "\\") { index += 2; continue; }
      if (raw[index] === '"') {
        index += 1;
        try { return JSON.parse(raw.slice(start, index)) as string; }
        catch { return malformed(); }
      }
      index += 1;
    }
    return malformed();
  };
  const parseScalar = (): void => {
    if (raw[index] === '"') { readString(); return; }
    const start = index;
    while (index < raw.length && !/[\s,\]}]/.test(raw[index] ?? "")) index += 1;
    const token = raw.slice(start, index);
    try {
      const parsed = JSON.parse(token) as unknown;
      if (typeof parsed === "number" && !Number.isFinite(parsed)) throw new Error("nonfinite");
    } catch { malformed(); }
  };
  function parseObject(depth: number): void {
    index += 1; whitespace();
    const keys = new Set<string>();
    if (raw[index] === "}") { index += 1; return; }
    while (index < raw.length) {
      whitespace(); const key = readString();
      if (keys.has(key)) throw new ProtocolError(400, "DUPLICATE_JSON_KEY", "duplicate JSON key", { pointer: `/${key.replaceAll("~", "~0").replaceAll("/", "~1")}` });
      keys.add(key); whitespace();
      if (raw[index] !== ":") malformed();
      index += 1; parseValue(depth + 1); whitespace();
      if (raw[index] === "}") { index += 1; return; }
      if (raw[index] !== ",") malformed();
      index += 1;
    }
    malformed();
  }
  function parseArray(depth: number): void {
    index += 1; whitespace();
    if (raw[index] === "]") { index += 1; return; }
    while (index < raw.length) {
      parseValue(depth + 1); whitespace();
      if (raw[index] === "]") { index += 1; return; }
      if (raw[index] !== ",") malformed();
      index += 1;
    }
    malformed();
  }
  function parseValue(depth: number): void {
    if (depth > maximumDepth) throw new ProtocolError(400, "JSON_DEPTH_EXCEEDED", "JSON nesting too deep");
    whitespace();
    if (raw[index] === "{") { parseObject(depth); return; }
    if (raw[index] === "[") { parseArray(depth); return; }
    parseScalar();
  }
  parseValue(1); whitespace();
  if (index !== raw.length) malformed();
  try { return JSON.parse(raw) as unknown; }
  catch { return malformed(); }
}

export interface SafeTelemetryEvent {
  readonly operationId: string;
  readonly routeTemplate: string;
  readonly statusCode: number;
  readonly latencyBucket: "lt10ms" | "lt100ms" | "lt1000ms" | "gte1000ms";
  readonly resultCode: string;
}

export function safeTelemetryEvent(input: { operationId: string; routeTemplate: string; statusCode: number; elapsedMs: number; resultCode: string }): SafeTelemetryEvent {
  const latencyBucket = input.elapsedMs < 10 ? "lt10ms" : input.elapsedMs < 100 ? "lt100ms" : input.elapsedMs < 1000 ? "lt1000ms" : "gte1000ms";
  return Object.freeze({ operationId: input.operationId, routeTemplate: input.routeTemplate, statusCode: input.statusCode, latencyBucket, resultCode: input.resultCode });
}
