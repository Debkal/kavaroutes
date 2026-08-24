import type { OutboxRoute } from "./contracts.js";

export type FailureClass = "TRANSIENT_DEPENDENCY" | "PROVIDER_THROTTLE" | "DATABASE_CONCURRENCY" | "PERMANENT_VALIDATION" | "AUTHORIZATION_CONFIGURATION" | "UNSUPPORTED_SCHEMA" | "AMBIGUOUS_EXTERNAL_OUTCOME";

export interface RetryPolicy {
  readonly retryable: boolean;
  readonly maximumAttempts: number;
  readonly baseDelaySeconds: number;
  readonly maximumDelaySeconds: number;
  readonly maximumAgeSeconds: number;
  readonly jitter: "FULL" | "NONE";
  readonly retryableCodes: readonly string[];
  readonly respectRetryAfter: boolean;
  readonly circuitOpenAfter: number;
  readonly concurrencyLimit: number;
  readonly deadLetterReason: string;
  readonly owner: string;
  readonly terminalAction: "DEAD_LETTER" | "BLOCK" | "MANUAL_REVIEW";
}

export const FAILURE_POLICIES: Readonly<Record<FailureClass, RetryPolicy>> = Object.freeze({
  TRANSIENT_DEPENDENCY: { retryable: true, maximumAttempts: 8, baseDelaySeconds: 2, maximumDelaySeconds: 300, maximumAgeSeconds: 86_400, jitter: "FULL", retryableCodes: ["ECONNRESET", "ETIMEDOUT", "HTTP_502", "HTTP_503", "HTTP_504"], respectRetryAfter: false, circuitOpenAfter: 5, concurrencyLimit: 8, deadLetterReason: "TRANSIENT_EXHAUSTED", owner: "platform", terminalAction: "DEAD_LETTER" },
  PROVIDER_THROTTLE: { retryable: true, maximumAttempts: 6, baseDelaySeconds: 15, maximumDelaySeconds: 900, maximumAgeSeconds: 259_200, jitter: "FULL", retryableCodes: ["HTTP_429"], respectRetryAfter: true, circuitOpenAfter: 3, concurrencyLimit: 2, deadLetterReason: "PROVIDER_THROTTLE_EXHAUSTED", owner: "integrations", terminalAction: "DEAD_LETTER" },
  DATABASE_CONCURRENCY: { retryable: true, maximumAttempts: 10, baseDelaySeconds: 1, maximumDelaySeconds: 60, maximumAgeSeconds: 3_600, jitter: "FULL", retryableCodes: ["40001", "40P01", "53300"], respectRetryAfter: false, circuitOpenAfter: 8, concurrencyLimit: 8, deadLetterReason: "DATABASE_CONCURRENCY_EXHAUSTED", owner: "platform", terminalAction: "DEAD_LETTER" },
  PERMANENT_VALIDATION: { retryable: false, maximumAttempts: 1, baseDelaySeconds: 0, maximumDelaySeconds: 0, maximumAgeSeconds: 0, jitter: "NONE", retryableCodes: [], respectRetryAfter: false, circuitOpenAfter: 1, concurrencyLimit: 1, deadLetterReason: "PERMANENT_VALIDATION", owner: "domain-owner", terminalAction: "DEAD_LETTER" },
  AUTHORIZATION_CONFIGURATION: { retryable: false, maximumAttempts: 1, baseDelaySeconds: 0, maximumDelaySeconds: 0, maximumAgeSeconds: 0, jitter: "NONE", retryableCodes: [], respectRetryAfter: false, circuitOpenAfter: 1, concurrencyLimit: 1, deadLetterReason: "AUTHORIZATION_CONFIGURATION", owner: "security", terminalAction: "BLOCK" },
  UNSUPPORTED_SCHEMA: { retryable: false, maximumAttempts: 1, baseDelaySeconds: 0, maximumDelaySeconds: 0, maximumAgeSeconds: 0, jitter: "NONE", retryableCodes: [], respectRetryAfter: false, circuitOpenAfter: 1, concurrencyLimit: 1, deadLetterReason: "UNSUPPORTED_SCHEMA", owner: "platform", terminalAction: "BLOCK" },
  AMBIGUOUS_EXTERNAL_OUTCOME: { retryable: false, maximumAttempts: 1, baseDelaySeconds: 0, maximumDelaySeconds: 0, maximumAgeSeconds: 0, jitter: "NONE", retryableCodes: [], respectRetryAfter: false, circuitOpenAfter: 1, concurrencyLimit: 1, deadLetterReason: "AMBIGUOUS_EXTERNAL_OUTCOME", owner: "integrations", terminalAction: "MANUAL_REVIEW" },
});

export interface RoutePolicy {
  readonly route: OutboxRoute;
  readonly queue: string;
  readonly concurrency: number;
  readonly priority: number;
  readonly maximumAgeSeconds: number;
  readonly leaseSeconds: number;
  readonly heartbeatSeconds: number;
  readonly executionTimeoutSeconds: number;
  readonly warningDepth: number;
  readonly deadLetterOwner: string;
  readonly deadLetterRoute: string;
  readonly coalesce: "NONE" | "LATEST_PER_AGGREGATE";
}

export const ROUTE_POLICIES: Readonly<Record<OutboxRoute, RoutePolicy>> = Object.freeze({
  projection: { route: "projection", queue: "kr.projection.v1", concurrency: 16, priority: 90, maximumAgeSeconds: 3600, leaseSeconds: 30, heartbeatSeconds: 10, executionTimeoutSeconds: 20, warningDepth: 1000, deadLetterOwner: "platform", deadLetterRoute: "kr.projection.dead.v1", coalesce: "NONE" },
  "realtime-signal": { route: "realtime-signal", queue: "kr.realtime-signal.v1", concurrency: 12, priority: 100, maximumAgeSeconds: 300, leaseSeconds: 20, heartbeatSeconds: 5, executionTimeoutSeconds: 10, warningDepth: 500, deadLetterOwner: "platform", deadLetterRoute: "kr.realtime-signal.dead.v1", coalesce: "LATEST_PER_AGGREGATE" },
  integration: { route: "integration", queue: "kr.integration.v1", concurrency: 6, priority: 60, maximumAgeSeconds: 86400, leaseSeconds: 60, heartbeatSeconds: 15, executionTimeoutSeconds: 45, warningDepth: 250, deadLetterOwner: "integrations", deadLetterRoute: "kr.integration.dead.v1", coalesce: "NONE" },
  notification: { route: "notification", queue: "kr.notification.v1", concurrency: 8, priority: 70, maximumAgeSeconds: 21600, leaseSeconds: 45, heartbeatSeconds: 10, executionTimeoutSeconds: 30, warningDepth: 500, deadLetterOwner: "communications", deadLetterRoute: "kr.notification.dead.v1", coalesce: "NONE" },
  maps: { route: "maps", queue: "kr.maps.v1", concurrency: 4, priority: 50, maximumAgeSeconds: 7200, leaseSeconds: 90, heartbeatSeconds: 20, executionTimeoutSeconds: 75, warningDepth: 200, deadLetterOwner: "routing", deadLetterRoute: "kr.maps.dead.v1", coalesce: "LATEST_PER_AGGREGATE" },
  optimization: { route: "optimization", queue: "kr.optimization.v1", concurrency: 2, priority: 40, maximumAgeSeconds: 14400, leaseSeconds: 300, heartbeatSeconds: 60, executionTimeoutSeconds: 240, warningDepth: 50, deadLetterOwner: "routing", deadLetterRoute: "kr.optimization.dead.v1", coalesce: "LATEST_PER_AGGREGATE" },
  billing: { route: "billing", queue: "kr.billing.v1", concurrency: 4, priority: 80, maximumAgeSeconds: 86400, leaseSeconds: 60, heartbeatSeconds: 15, executionTimeoutSeconds: 45, warningDepth: 100, deadLetterOwner: "finance", deadLetterRoute: "kr.billing.dead.v1", coalesce: "NONE" },
  maintenance: { route: "maintenance", queue: "kr.maintenance.v1", concurrency: 1, priority: 10, maximumAgeSeconds: 604800, leaseSeconds: 300, heartbeatSeconds: 60, executionTimeoutSeconds: 240, warningDepth: 100, deadLetterOwner: "platform", deadLetterRoute: "kr.maintenance.dead.v1", coalesce: "NONE" },
});

export function retryDelayMilliseconds(failure: FailureClass, completedAttempts: number, random: () => number = Math.random): number | null {
  const policy = FAILURE_POLICIES[failure];
  if (!policy.retryable || completedAttempts >= policy.maximumAttempts) return null;
  const cap = Math.min(policy.maximumDelaySeconds, policy.baseDelaySeconds * (2 ** Math.max(0, completedAttempts - 1)));
  return Math.floor((policy.jitter === "FULL" ? random() * cap : cap) * 1000);
}
