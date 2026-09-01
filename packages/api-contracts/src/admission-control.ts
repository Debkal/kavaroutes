export interface AdmissionScope {
  readonly organizationId: string;
  readonly principalId: string;
  readonly operationId: string;
}

export interface AdmissionDecision {
  readonly allowed: boolean;
  readonly remaining: number;
  readonly retryAfterSeconds?: number;
  readonly reason?: "SCOPE_LIMIT_EXCEEDED" | "TRACKING_CAPACITY_EXCEEDED";
}

export interface AdmissionController {
  admit(scope: AdmissionScope): Promise<AdmissionDecision>;
}

interface WindowEntry {
  count: number;
  expiresAt: number;
}

const scopeFieldPattern = /^[A-Za-z0-9:_-]{1,128}$/;

function validateScope(scope: AdmissionScope): void {
  for (const value of [scope.organizationId, scope.principalId, scope.operationId]) {
    if (!scopeFieldPattern.test(value)) throw new Error("ADMISSION_SCOPE_INVALID");
  }
}

function retryAfterSeconds(expiresAt: number, now: number): number {
  return Math.max(1, Math.ceil((expiresAt - now) / 1_000));
}

export function createSyntheticLocalAdmissionController(options: {
  readonly limitPerWindow?: number;
  readonly windowMilliseconds?: number;
  readonly maximumTrackedScopes?: number;
  readonly now?: () => Date;
} = {}) {
  const limitPerWindow = options.limitPerWindow ?? 10_000;
  const windowMilliseconds = options.windowMilliseconds ?? 60_000;
  const maximumTrackedScopes = options.maximumTrackedScopes ?? 10_000;
  if (!Number.isInteger(limitPerWindow) || limitPerWindow < 1
    || !Number.isInteger(windowMilliseconds) || windowMilliseconds < 1_000 || windowMilliseconds > 86_400_000
    || !Number.isInteger(maximumTrackedScopes) || maximumTrackedScopes < 1) {
    throw new Error("ADMISSION_POLICY_INVALID");
  }
  const clock = options.now ?? (() => new Date());
  const windows = new Map<string, WindowEntry>();
  let observedTime = Number.NEGATIVE_INFINITY;

  function currentTime(): number {
    const candidate = clock().getTime();
    if (!Number.isFinite(candidate)) throw new Error("ADMISSION_CLOCK_INVALID");
    observedTime = Math.max(observedTime, candidate);
    return observedTime;
  }

  function removeExpired(now: number): void {
    for (const [key, entry] of windows) if (entry.expiresAt <= now) windows.delete(key);
  }

  async function admit(scope: AdmissionScope): Promise<AdmissionDecision> {
    validateScope(scope);
    const now = currentTime();
    removeExpired(now);
    const key = JSON.stringify([scope.organizationId, scope.principalId, scope.operationId]);
    const existing = windows.get(key);
    if (!existing) {
      if (windows.size >= maximumTrackedScopes) {
        const nextExpiry = Math.min(...[...windows.values()].map((entry) => entry.expiresAt));
        return Object.freeze({ allowed: false, remaining: 0, retryAfterSeconds: retryAfterSeconds(nextExpiry, now), reason: "TRACKING_CAPACITY_EXCEEDED" });
      }
      windows.set(key, { count: 1, expiresAt: now + windowMilliseconds });
      return Object.freeze({ allowed: true, remaining: limitPerWindow - 1 });
    }
    if (existing.count >= limitPerWindow) {
      return Object.freeze({ allowed: false, remaining: 0, retryAfterSeconds: retryAfterSeconds(existing.expiresAt, now), reason: "SCOPE_LIMIT_EXCEEDED" });
    }
    existing.count += 1;
    return Object.freeze({ allowed: true, remaining: limitPerWindow - existing.count });
  }

  return Object.freeze({
    admit,
    trackedScopes: () => windows.size,
    productionReady: false as const,
  });
}

export type SyntheticLocalAdmissionController = ReturnType<typeof createSyntheticLocalAdmissionController>;
