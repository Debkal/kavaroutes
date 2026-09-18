import { selectPonyPersona } from './pony-fixtures.js';

/** Shared web/native transport for the IAP-forwarded, synthetic development API.
 * This is deliberately not a production identity or public endpoint adapter.
 */
export interface DevelopmentResponse {
  readonly status: number;
  readonly headers: { get(name: string): string | null };
  json(): Promise<unknown>;
}
export interface DevelopmentFetch {
  (url: string, init: {
    method: "GET" | "POST";
    headers: Record<string, string>;
    body?: string;
    signal: AbortSignal;
    redirect: "error";
    credentials: "omit" | "same-origin";
    cache: "no-store";
  }): Promise<DevelopmentResponse>;
}
export class DevelopmentApiError extends Error {
  readonly status: number;
  readonly code: string;
  /** The server's own request id when it stated one, so an operator can quote it. */
  readonly requestId?: string;
  constructor(status: number, code: string, requestId?: string) {
    super(code); this.name = "DevelopmentApiError"; this.status = status; this.code = code;
    if (requestId !== undefined) this.requestId = requestId;
  }
}
export type DevelopmentPersona = "dispatcher" | "driver" | "facility" | "billing" | "policy_override";

export function createPrivateDevelopmentTransport(options: {
  readonly baseUrl: string;
  readonly persona: DevelopmentPersona;
  readonly ponyCompany?: string;
  readonly fetch: DevelopmentFetch;
  readonly timeoutMs?: number;
  /** Explicitly permits the synthetic web prototype behind an HTTPS edge session.
   * Native clients and local tools must leave this disabled.
   */
  readonly browserSameOrigin?: boolean;
}) {
  const base = new URL(options.baseUrl);
  const loopback = base.protocol === "http:" && base.hostname === "127.0.0.1" && Boolean(base.port);
  const edgePrototype = options.browserSameOrigin === true && base.protocol === "https:" && !base.port;
  if ((!loopback && !edgePrototype) || base.pathname !== "/" || base.username || base.password || base.search || base.hash) {
    throw new Error("PRIVATE_DEVELOPMENT_LOOPBACK_REQUIRED");
  }
  if (!["dispatcher", "driver", "facility", "billing", "policy_override"].includes(options.persona)) throw new Error("INVALID_DEVELOPMENT_PERSONA");
  const token = options.ponyCompany === undefined ? `principal_${options.persona}`
    : selectPonyPersona(options.ponyCompany, options.persona).token;
  const timeoutMs = options.timeoutMs ?? 15_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) throw new Error("INVALID_REQUEST_TIMEOUT");
  return Object.freeze({
    async request<T>(path: string, decode: (body: unknown) => T, command?: {
      readonly body: unknown;
      readonly idempotencyKey: string;
      readonly etag?: string;
    }, signal?: AbortSignal): Promise<{ readonly value: T; readonly etag: string | null; readonly replayed: boolean }> {
      // Never let an absolute URL, encoded path, or traversal forward identity elsewhere.
      const pathname = path.split("?")[0]!;
      if (!/^\/v1\/[A-Za-z0-9_/-]+$/.test(pathname) || pathname.includes("//") ||
          path.includes("#") || path.includes("\\") || new URL(path, base).origin !== base.origin) {
        throw new Error("INVALID_API_PATH");
      }
      const controller = new AbortController();
      const abort = () => controller.abort();
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) controller.abort();
      const timer = setTimeout(abort, timeoutMs);
      const headers: Record<string, string> = { authorization: `Synthetic ${token}`, accept: "application/json" };
      try {
        if (command) {
          if (!command.idempotencyKey || /[\r\n]/.test(command.idempotencyKey)) throw new Error("IDEMPOTENCY_KEY_REQUIRED");
          headers["content-type"] = "application/json";
          headers["idempotency-key"] = command.idempotencyKey;
          if (command.etag !== undefined) headers["if-match"] = command.etag;
        }
        let response: DevelopmentResponse;
        try {
          response = await options.fetch(new URL(path, base).href, {
            method: command ? "POST" : "GET", headers,
            ...(command ? { body: JSON.stringify(command.body) } : {}),
            signal: controller.signal, redirect: "error",
            credentials: edgePrototype ? "same-origin" : "omit", cache: "no-store",
          });
        } catch {
          // A failed transport does not prove whether a submitted command committed.
          throw new DevelopmentApiError(0, command ? "OUTCOME_UNKNOWN" : "BACKEND_UNAVAILABLE");
        }
        if (response.status < 200 || response.status >= 300) {
          // The server states a closed reason code for a refused command. Only a
          // code-shaped token and a request id are read out of the body; no message,
          // field or identifier text is copied into the UI.
          let stated: {code?: unknown; requestId?: unknown} | null = null;
          try { stated = await response.json() as {code?: unknown; requestId?: unknown}; } catch { stated = null; }
          const statedCode = typeof stated?.code === "string" && /^[A-Z][A-Z0-9_]{2,60}$/.test(stated.code) ? stated.code : null;
          const requestId = typeof stated?.requestId === "string" && /^req_[A-Za-z0-9_-]{1,64}$/.test(stated.requestId) ? stated.requestId : null;
          // A stated closed code wins over the status: a 401 from a login route is
          // DRIVER_LOGIN_REJECTED, not an expired session, and a 412 is the specific
          // stale-version conflict the caller has to act on. The status mapping stays as
          // the fallback for a response that states nothing.
          const code = statedCode ?? (response.status === 401 ? "SESSION_EXPIRED" : response.status === 403 ? "CAPABILITY_DENIED"
            // A 409 can be a duplicate proof, a policy conflict, or a stale command.
            // Do not infer a version mismatch from status alone.
            : response.status === 409 ? "REQUEST_CONFLICT" : response.status === 412 ? "VERSION_CONFLICT"
            : response.status === 503 ? "BACKEND_UNAVAILABLE" : "API_REQUEST_REJECTED");
          throw new DevelopmentApiError(response.status, code, requestId ?? undefined);
        }
        try {
          return { value: decode(await response.json()), etag: response.headers.get("etag"),
            replayed: response.headers.get("kavaroutes-idempotency-replayed") === "true" };
        } catch {
          throw new DevelopmentApiError(response.status, command ? "OUTCOME_UNKNOWN" : "INVALID_API_RESPONSE");
        }
      } finally { clearTimeout(timer); signal?.removeEventListener("abort", abort); }
    },
  });
}
