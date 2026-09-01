export const API_NETWORK_LIMITS = Object.freeze({
  headersTimeoutMs: 10_000,
  requestTimeoutMs: 30_000,
  handlerTimeoutMs: 30_000,
  connectionTimeoutMs: 30_000,
  keepAliveTimeoutMs: 60_000,
  maxRequestsPerSocket: 1_000
});

export type ApiRuntimeProfile = "local-synthetic" | "public-production";

export interface ApiHostRuntime {
  readonly profile: "local-synthetic";
  readonly host: "127.0.0.1" | "::1";
  readonly port: number;
}

type RuntimeEnvironment = Readonly<Record<string, string | undefined>>;

function resolveProfile(environment: RuntimeEnvironment): ApiRuntimeProfile {
  const configured = environment.KAVAROUTES_RUNTIME_PROFILE;
  if (configured === undefined) {
    return environment.NODE_ENV === "production" ? "public-production" : "local-synthetic";
  }
  if (configured !== "local-synthetic" && configured !== "public-production") {
    throw new Error("UNRECOGNIZED_RUNTIME_PROFILE");
  }
  if (environment.NODE_ENV === "production" && configured === "local-synthetic") {
    throw new Error("SYNTHETIC_PROFILE_FORBIDDEN_IN_PRODUCTION");
  }
  return configured;
}

function resolveLoopbackHost(value: string | undefined): ApiHostRuntime["host"] {
  const host = value ?? "127.0.0.1";
  if (host !== "127.0.0.1" && host !== "::1") {
    throw new Error("SYNTHETIC_LISTENER_MUST_USE_EXPLICIT_LOOPBACK");
  }
  return host;
}

function resolvePort(value: string | undefined): number {
  const source = value ?? "3000";
  if (!/^[1-9][0-9]{0,4}$/.test(source)) {
    throw new Error("INVALID_LISTENER_PORT");
  }
  const port = Number(source);
  if (!Number.isSafeInteger(port) || port > 65_535) {
    throw new Error("INVALID_LISTENER_PORT");
  }
  return port;
}

export function resolveApiHostRuntime(environment: RuntimeEnvironment): ApiHostRuntime {
  const profile = resolveProfile(environment);
  if (profile === "public-production") {
    // This host still composes synthetic identity and cleartext HTTP. A future
    // production host must prove the complete TRN-001 identity/TLS boundary.
    throw new Error("PUBLIC_PRODUCTION_COMPOSITION_NOT_IMPLEMENTED");
  }
  return Object.freeze({
    profile,
    host: resolveLoopbackHost(environment.HOST),
    port: resolvePort(environment.PORT)
  });
}
