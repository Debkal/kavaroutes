export interface TransportResponse {
  readonly status: number;
  readonly safeReason?: string;
  readonly retryAfterSeconds?: number;
}

const boundedProviderTransport = Symbol("kavaroutes.bounded-provider-transport");

export interface ProviderTransport {
  readonly securityProfile: "bounded-https-v1";
  readonly [boundedProviderTransport]: true;
  exchange(request: {
    readonly endpoint: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly body: string;
  }): Promise<TransportResponse>;
}

export function isBoundedProviderTransport(value: unknown): value is ProviderTransport {
  return typeof value === "object" && value !== null
    && (value as { readonly [boundedProviderTransport]?: unknown })[boundedProviderTransport] === true;
}

export interface ProviderConnector {
  exchange(request: {
    readonly endpoint: string;
    readonly method: "POST";
    readonly headers: Readonly<Record<string, string>>;
    readonly body: string;
    readonly redirect: "error";
    readonly rejectUnauthorized: true;
    readonly connectTimeoutMs: number;
    readonly maxResponseBytes: number;
    readonly signal: AbortSignal;
  }): Promise<{ readonly status: number; readonly headers?: Readonly<Record<string, string>>; readonly body?: string }>;
}

export interface ProviderTransportEvent {
  readonly provider: "apns" | "fcm";
  readonly outcome: "response" | "connect_failure" | "ambiguous_timeout" | "policy_rejection";
  readonly statusBucket?: "2xx" | "4xx" | "5xx" | "other";
}

const APNS_ORIGIN = "https://api.sandbox.push.apple.com";
const FCM_ORIGIN = "https://fcm.googleapis.com";
const ALLOWED_REASONS = new Set(["BadDeviceToken", "DeviceTokenNotForTopic", "UNREGISTERED"]);

function providerRequest(endpoint: string): { readonly provider: "apns" | "fcm"; readonly url: URL } {
  const url = new URL(endpoint);
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.search || url.hash) {
    throw new Error("PROVIDER_ENDPOINT_POLICY_REJECTED");
  }
  if (url.origin === APNS_ORIGIN && /^\/3\/device\/[A-Za-z0-9_-]{16,256}$/.test(url.pathname)) return { provider: "apns", url };
  if (url.origin === FCM_ORIGIN && /^\/v1\/projects\/[A-Za-z0-9_-]{1,128}\/messages:send$/.test(url.pathname)) return { provider: "fcm", url };
  throw new Error("PROVIDER_ENDPOINT_POLICY_REJECTED");
}

function safeHeaders(provider: "apns" | "fcm", headers: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
  const allowed = provider === "apns"
    ? new Set(["authorization", "apns-topic", "apns-push-type", "apns-priority", "apns-expiration", "apns-collapse-id"])
    : new Set(["authorization", "content-type"]);
  const normalized: Record<string, string> = {};
  for (const [rawName, value] of Object.entries(headers)) {
    const name = rawName.toLowerCase();
    if (!allowed.has(name) || typeof value !== "string" || value.length > 2_048 || /[\r\n]/.test(value)) {
      throw new Error("PROVIDER_HEADER_POLICY_REJECTED");
    }
    normalized[name] = value;
  }
  if (!normalized.authorization) throw new Error("PROVIDER_AUTHORIZATION_REQUIRED");
  return Object.freeze(normalized);
}

function safeReason(provider: "apns" | "fcm", body: string | undefined): string | undefined {
  if (!body) return undefined;
  try {
    const parsed = JSON.parse(body) as { reason?: unknown; error?: { details?: Array<{ errorCode?: unknown }> } };
    const candidate = provider === "apns"
      ? parsed.reason
      : parsed.error?.details?.find((detail) => typeof detail.errorCode === "string")?.errorCode;
    return typeof candidate === "string" && ALLOWED_REASONS.has(candidate) ? candidate : undefined;
  } catch {
    return undefined;
  }
}

const statusBucket = (status: number): "2xx" | "4xx" | "5xx" | "other" => {
  if (status >= 200 && status < 300) return "2xx";
  if (status >= 400 && status < 500) return "4xx";
  if (status >= 500 && status < 600) return "5xx";
  return "other";
};

export function createBoundedProviderTransport(options: {
  readonly connector: ProviderConnector;
  readonly connectTimeoutMs?: number;
  readonly totalTimeoutMs?: number;
  readonly maxRequestBytes?: number;
  readonly maxResponseBytes?: number;
  readonly telemetrySink?: (event: ProviderTransportEvent) => void;
}): ProviderTransport {
  const connectTimeoutMs = options.connectTimeoutMs ?? 3_000;
  const totalTimeoutMs = options.totalTimeoutMs ?? 8_000;
  const maxRequestBytes = options.maxRequestBytes ?? 16_384;
  const maxResponseBytes = options.maxResponseBytes ?? 16_384;
  if (connectTimeoutMs < 1 || totalTimeoutMs < connectTimeoutMs || maxRequestBytes < 1 || maxResponseBytes < 1) {
    throw new Error("PROVIDER_TRANSPORT_LIMITS_INVALID");
  }

  return Object.freeze({
    securityProfile: "bounded-https-v1" as const,
    [boundedProviderTransport]: true as const,
    async exchange(request: { readonly endpoint: string; readonly headers: Readonly<Record<string, string>>; readonly body: string }) {
      let parsed: ReturnType<typeof providerRequest>;
      let headers: Readonly<Record<string, string>>;
      try {
        parsed = providerRequest(request.endpoint);
        if (Buffer.byteLength(request.body, "utf8") > maxRequestBytes) throw new Error("PROVIDER_REQUEST_TOO_LARGE");
        headers = safeHeaders(parsed.provider, request.headers);
      } catch (error) {
        options.telemetrySink?.(Object.freeze({ provider: request.endpoint.includes("fcm.googleapis.com") ? "fcm" : "apns", outcome: "policy_rejection" }));
        throw error;
      }
      const controller = new AbortController();
      let timedOut = false;
      let timer: ReturnType<typeof setTimeout>;
      try {
        const connectorExchange = options.connector.exchange({
          endpoint: parsed.url.href,
          method: "POST",
          headers,
          body: request.body,
          redirect: "error",
          rejectUnauthorized: true,
          connectTimeoutMs,
          maxResponseBytes,
          signal: controller.signal,
        });
        const timeout = new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => { timedOut = true; controller.abort(); reject(new Error("PROVIDER_TOTAL_TIMEOUT")); }, totalTimeoutMs);
        });
        const response = await Promise.race([connectorExchange, timeout]);
        if (!Number.isInteger(response.status) || response.status < 100 || response.status > 599) throw new Error("PROVIDER_RESPONSE_STATUS_INVALID");
        if (Buffer.byteLength(response.body ?? "", "utf8") > maxResponseBytes) throw new Error("PROVIDER_RESPONSE_TOO_LARGE");
        options.telemetrySink?.(Object.freeze({ provider: parsed.provider, outcome: "response", statusBucket: statusBucket(response.status) }));
        const retryAfter = response.headers?.["retry-after"];
        const retryAfterSeconds = retryAfter && /^\d{1,5}$/.test(retryAfter) ? Math.min(Number(retryAfter), 86_400) : undefined;
        const reason = safeReason(parsed.provider, response.body);
        return Object.freeze({
          status: response.status,
          ...(reason === undefined ? {} : { safeReason: reason }),
          ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
        });
      } catch {
        const outcome = timedOut ? "ambiguous_timeout" : "connect_failure";
        options.telemetrySink?.(Object.freeze({ provider: parsed.provider, outcome }));
        return Object.freeze({ status: 503, safeReason: timedOut ? "AMBIGUOUS_TIMEOUT" : "CONNECT_FAILURE" });
      } finally {
        clearTimeout(timer!);
      }
    },
  });
}
