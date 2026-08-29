import { GENERIC_VISIBLE_COPY, createPushEnvelope, type PushEnvelope, type PushKind } from "./contracts.js";
import type { PushPlatform } from "./registrations.js";

export interface DeliveryInstruction {
  readonly policyVersion: "push.policy.v1";
  readonly platform: PushPlatform;
  readonly envelope: PushEnvelope;
  readonly visible: boolean;
  readonly title?: string;
  readonly body?: string;
  readonly collapseClass: "sync" | "review" | "session";
  readonly expiresAt: string;
  readonly priority: "low" | "normal" | "high";
}

const collapse = Object.freeze({ sync_available: "sync", review_update: "review", session_attention: "session" } as const);

export function deriveDeliveryInstruction(input: { readonly kind: PushKind; readonly platform: PushPlatform; readonly createdAt: string }): DeliveryInstruction {
  const created = Date.parse(input.createdAt); if (!Number.isFinite(created)) throw new Error("PUSH_INTENT_TIME_INVALID");
  const visible = input.kind !== "sync_available";
  const copy = visible ? GENERIC_VISIBLE_COPY[input.kind] : undefined;
  return Object.freeze({
    policyVersion: "push.policy.v1", platform: input.platform, envelope: createPushEnvelope(input.kind), visible,
    ...(copy ? { title: copy.title, body: copy.body } : {}), collapseClass: collapse[input.kind],
    expiresAt: new Date(created + 300_000).toISOString(), priority: visible ? "high" : input.platform === "ios" ? "low" : "normal",
  });
}

export function createAdmissionController(options: { readonly now?: () => Date } = {}) {
  const now = options.now ?? (() => new Date());
  const silentIosSends = new Map<string, number[]>();
  const latestByCollapse = new Map<string, string>();
  return Object.freeze({
    admit(input: { readonly installationKey: string; readonly intentId: string; readonly instruction: DeliveryInstruction }): "admitted" | "rate_limited" | "superseded" | "expired" {
      const current = now().getTime();
      if (Date.parse(input.instruction.expiresAt) <= current) return "expired";
      const collapseKey = `${input.installationKey}:${input.instruction.collapseClass}`;
      const latest = latestByCollapse.get(collapseKey);
      if (latest && latest > input.intentId) return "superseded";
      latestByCollapse.set(collapseKey, input.intentId);
      if (input.instruction.platform === "ios" && input.instruction.envelope.kind === "sync_available") {
        const windowStart = current - 3_600_000;
        const sends = (silentIosSends.get(input.installationKey) ?? []).filter((value) => value > windowStart);
        if (sends.length >= 2) return "rate_limited";
        silentIosSends.set(input.installationKey, [...sends, current]);
      }
      return "admitted";
    },
  });
}

export function retryDelayMilliseconds(input: { readonly outcome: "throttled" | "transient_provider" | "ambiguous_timeout"; readonly attempt: number; readonly retryAfterSeconds?: number; readonly jitter?: number }): number {
  if (!Number.isInteger(input.attempt) || input.attempt < 1 || input.attempt > 5) throw new Error("PUSH_RETRY_ATTEMPT_INVALID");
  if (input.retryAfterSeconds !== undefined) return Math.max(60_000, input.retryAfterSeconds * 1_000);
  const base = input.outcome === "throttled" ? 60_000 : 15_000;
  const jitter = Math.min(1, Math.max(0, input.jitter ?? 0.5));
  return Math.round(Math.min(900_000, base * 2 ** (input.attempt - 1)) * (0.75 + jitter * 0.5));
}
