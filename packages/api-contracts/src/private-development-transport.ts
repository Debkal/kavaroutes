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
    credentials: "omit";
    cache: "no-store";
  }): Promise<DevelopmentResponse>;
}
export class DevelopmentApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string) {
    super(code); this.name = "DevelopmentApiError"; this.status = status; this.code = code;
  }
}
export type DevelopmentPersona = "dispatcher" | "driver" | "facility" | "policy_override";

export function createPrivateDevelopmentTransport(options: {
  readonly baseUrl: string;
  readonly persona: DevelopmentPersona;
  readonly ponyCompany?: string;
  readonly fetch: DevelopmentFetch;
  readonly timeoutMs?: number;
}) {
  const base = new URL(options.baseUrl);
  if (base.protocol !== "http:" || base.hostname !== "127.0.0.1" || !base.port ||
      base.pathname !== "/" || base.username || base.password || base.search || base.hash) {
    throw new Error("PRIVATE_DEVELOPMENT_LOOPBACK_REQUIRED");
  }
  if (!["dispatcher", "driver", "facility", "policy_override"].includes(options.persona)) throw new Error("INVALID_DEVELOPMENT_PERSONA");
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
            signal: controller.signal, redirect: "error", credentials: "omit", cache: "no-store",
          });
        } catch {
          // A failed transport does not prove whether a submitted command committed.
          throw new DevelopmentApiError(0, command ? "OUTCOME_UNKNOWN" : "BACKEND_UNAVAILABLE");
        }
        if (response.status < 200 || response.status >= 300) {
          // Do not copy untrusted response details (or patient data) into UI/log errors.
          const code = response.status === 401 ? "SESSION_EXPIRED" : response.status === 403 ? "CAPABILITY_DENIED"
            // A 409 can be a duplicate proof, a policy conflict, or a stale command.
            // Do not infer a version mismatch from status alone.
            : response.status === 409 ? "REQUEST_CONFLICT" : response.status === 412 ? "VERSION_CONFLICT"
            : response.status === 503 ? "BACKEND_UNAVAILABLE" : "API_REQUEST_REJECTED";
          throw new DevelopmentApiError(response.status, code);
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
