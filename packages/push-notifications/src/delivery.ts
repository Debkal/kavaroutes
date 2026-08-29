import { createHash } from "node:crypto";
import { assertProviderBoundaryEnvelope, type PushKind } from "./contracts.js";
import { createAdmissionController, deriveDeliveryInstruction, retryDelayMilliseconds, type DeliveryInstruction } from "./policy.js";
import type { PushPlatform, PushProvider } from "./registrations.js";

export const PUSH_OUTCOMES = ["accepted", "invalid_registration", "permanent_payload_or_auth", "throttled", "transient_provider", "ambiguous_timeout", "superseded", "expired"] as const;
export type PushOutcome = typeof PUSH_OUTCOMES[number];

export interface PushResult { readonly outcome: PushOutcome; readonly retryAfterSeconds?: number; readonly safeCode: string; }
export interface PushTarget { readonly platform: PushPlatform; readonly provider: PushProvider; readonly environment: "sandbox" | "development"; readonly appId: string; readonly token: string; }
export interface PushPort { send(target: PushTarget, instruction: DeliveryInstruction): Promise<PushResult>; }
export interface NotificationIntent { readonly intentId: string; readonly kind: PushKind; readonly createdAt: string; readonly policyVersion: "push.policy.v1"; readonly envelope: ReturnType<typeof assertProviderBoundaryEnvelope>; }
export interface DeliveryTarget extends PushTarget { readonly installationKey: string; }

export function createNotificationIntent(input: { readonly intentId: string; readonly kind: PushKind; readonly createdAt: string }): NotificationIntent {
  if (!/^intent_[a-z0-9_-]{12,96}$/.test(input.intentId) || !Number.isFinite(Date.parse(input.createdAt))) throw new Error("PUSH_INTENT_INVALID");
  return Object.freeze({ ...input, policyVersion: "push.policy.v1", envelope: assertProviderBoundaryEnvelope({ v: "1", kind: input.kind, action: "open_and_sync" }) });
}

interface Effect { readonly key: string; readonly fingerprint: string; state: "planned" | "provider_accepted" | "retry_scheduled" | "permanent" | "ambiguous" | "expired" | "superseded"; attempts: number; outcome?: PushOutcome; nextAttemptAt?: string; }

export function createDeliveryCoordinator(options: { readonly now?: () => Date; readonly admission?: ReturnType<typeof createAdmissionController> } = {}) {
  const now = options.now ?? (() => new Date()); const admission = options.admission ?? createAdmissionController({ now });
  const effects = new Map<string, Effect>();
  return Object.freeze({
    async deliver(intent: NotificationIntent, target: DeliveryTarget, port: PushPort) {
      const instruction = deriveDeliveryInstruction({ kind: intent.kind, platform: target.platform, createdAt: intent.createdAt });
      const effectKey = `${intent.intentId}:${target.installationKey}`;
      const fingerprint = createHash("sha256").update(JSON.stringify({ envelope: intent.envelope, provider: target.provider, appId: target.appId, collapse: instruction.collapseClass, expiresAt: instruction.expiresAt })).digest("hex");
      const prior = effects.get(effectKey);
      if (prior && prior.fingerprint !== fingerprint) throw new Error("PUSH_EFFECT_IDEMPOTENCY_MISMATCH");
      if (prior?.state === "provider_accepted" || prior?.state === "permanent" || prior?.state === "ambiguous" || prior?.state === "expired" || prior?.state === "superseded") return Object.freeze({ effectKey, state: prior.state, outcome: prior.outcome, attempts: prior.attempts });
      const effect: Effect = prior ?? { key: effectKey, fingerprint, state: "planned", attempts: 0 }; effects.set(effectKey, effect);
      const decision = prior ? "admitted" : admission.admit({ installationKey: target.installationKey, intentId: intent.intentId, instruction });
      if (decision !== "admitted") {
        effect.state = decision === "expired" ? "expired" : decision === "superseded" ? "superseded" : "retry_scheduled";
        effect.outcome = decision === "expired" ? "expired" : decision === "superseded" ? "superseded" : "throttled";
        if (decision === "rate_limited") effect.nextAttemptAt = new Date(now().getTime() + 1_800_000).toISOString();
        return Object.freeze({ effectKey, state: effect.state, outcome: effect.outcome, attempts: effect.attempts, ...(effect.nextAttemptAt ? { nextAttemptAt: effect.nextAttemptAt } : {}) });
      }
      effect.attempts += 1;
      const result = await port.send(target, instruction);
      effect.outcome = result.outcome;
      if (result.outcome === "accepted") effect.state = "provider_accepted";
      else if (result.outcome === "invalid_registration" || result.outcome === "permanent_payload_or_auth") effect.state = "permanent";
      else if (result.outcome === "expired") effect.state = "expired";
      else if (result.outcome === "superseded") effect.state = "superseded";
      else if (result.outcome === "ambiguous_timeout") effect.state = "ambiguous";
      else {
        effect.state = "retry_scheduled";
        if (effect.attempts < 5) effect.nextAttemptAt = new Date(now().getTime() + retryDelayMilliseconds({ outcome: result.outcome, attempt: effect.attempts, ...(result.retryAfterSeconds === undefined ? {} : { retryAfterSeconds: result.retryAfterSeconds }) })).toISOString();
        else effect.state = "permanent";
      }
      return Object.freeze({ effectKey, state: effect.state, outcome: result.outcome, attempts: effect.attempts, ...(effect.nextAttemptAt ? { nextAttemptAt: effect.nextAttemptAt } : {}) });
    },
    resolveAmbiguous(effectKey: string, decision: "provider_accepted" | "retry_authorized") {
      const effect = effects.get(effectKey); if (!effect || effect.state !== "ambiguous") throw new Error("PUSH_EFFECT_NOT_AMBIGUOUS");
      effect.state = decision === "provider_accepted" ? "provider_accepted" : "planned";
      if (decision === "provider_accepted") effect.outcome = "accepted";
      return Object.freeze({ ...effect });
    },
    effect(effectKey: string) { const value = effects.get(effectKey); return value ? Object.freeze({ ...value }) : undefined; },
  });
}

export function createFakePushPort(sequence: readonly PushOutcome[] = ["accepted"]): PushPort & { readonly calls: readonly { readonly tokenHash: string; readonly instruction: DeliveryInstruction }[] } {
  const calls: { readonly tokenHash: string; readonly instruction: DeliveryInstruction }[] = [];
  return Object.freeze({
    calls,
    async send(target: PushTarget, instruction: DeliveryInstruction) {
      assertProviderBoundaryEnvelope(instruction.envelope);
      calls.push(Object.freeze({ tokenHash: createHash("sha256").update(target.token).digest("hex"), instruction }));
      const outcome = sequence[Math.min(calls.length - 1, sequence.length - 1)] ?? "accepted";
      return Object.freeze({ outcome, safeCode: `FAKE_${outcome.toUpperCase()}`, ...(outcome === "throttled" ? { retryAfterSeconds: 60 } : {}) });
    },
  });
}
