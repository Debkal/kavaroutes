import { createHash, randomUUID } from "node:crypto";
import type { Pool } from "pg";

const retentionMilliseconds = 2_592_300_000;
const hash = (value: string): string => createHash("sha256").update(value).digest("hex");

export interface EffectProvider {
  readonly supportsIdempotency: boolean;
  readonly supportsReconciliation: boolean;
  perform(input: { readonly operation: string; readonly idempotencyKey: string; readonly requestFingerprint: string }): Promise<{ readonly providerReference: string }>;
  reconcile?(idempotencyKey: string): Promise<{ readonly found: boolean; readonly providerReference?: string }>;
}

export class AmbiguousProviderOutcome extends Error {
  constructor() { super("AMBIGUOUS_EXTERNAL_OUTCOME"); this.name = "AmbiguousProviderOutcome"; }
}

export class TransientProviderFailure extends Error {
  constructor() { super("TRANSIENT_DEPENDENCY"); this.name = "TransientProviderFailure"; }
}

export class PermanentProviderFailure extends Error {
  constructor() { super("PERMANENT_VALIDATION"); this.name = "PermanentProviderFailure"; }
}

export function createOutboundEffectService(pool: Pool, options: { readonly idFactory?: () => string; readonly now?: () => Date } = {}) {
  const idFactory = options.idFactory ?? randomUUID;
  const now = options.now ?? (() => new Date());
  async function update(tenantId: string, logicalEffectKey: string, state: string, reconciliation: string, outcome: string, providerReference?: string): Promise<void> {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE kavaroutes_outbox_consumer");
      await client.query("SELECT set_config('app.tenant_id',$1,true)", [tenantId]);
      await client.query(`UPDATE outbox.outbound_effect SET attempt_state=$1,reconciliation_state=$2,safe_outcome_code=$3,
        provider_reference_hash=$4,updated_at=now(),reconciled_at=CASE WHEN $2='CONFIRMED' THEN now() ELSE reconciled_at END
        WHERE tenant_id=$5 AND logical_effect_key=$6`, [state, reconciliation, outcome,
        providerReference ? hash(providerReference) : null, tenantId, logicalEffectKey]);
      await client.query("COMMIT");
    } catch (error) { try { await client.query("ROLLBACK"); } catch { /* original failure wins */ } throw error; }
    finally { client.release(); }
  }
  return Object.freeze({
    async execute(input: { tenantId: string; deliveryId: string; eventId: string; logicalEffectKey: string; operation: string; requestFingerprint: string }, provider: EffectProvider): Promise<"SUCCEEDED" | "RECONCILED" | "PERMANENT_FAILURE" | "MANUAL_REVIEW"> {
      if (!/^effect_[a-z0-9_-]{8,96}$/.test(input.logicalEffectKey) || !/^[A-Z][A-Z0-9_]{2,63}$/.test(input.operation) || !/^[0-9a-f]{64}$/.test(input.requestFingerprint)) throw new Error("INVALID_EFFECT_REQUEST");
      const idempotencyHash = hash(`${input.tenantId}:${input.logicalEffectKey}`);
      const client = await pool.connect();
      let existingState: string | undefined;
      try {
        await client.query("BEGIN");
        await client.query("SET LOCAL ROLE kavaroutes_outbox_consumer");
        await client.query("SELECT set_config('app.tenant_id',$1,true)", [input.tenantId]);
        const inserted = await client.query(`INSERT INTO outbox.outbound_effect
          (tenant_id,id,logical_effect_key,event_id,delivery_id,provider_operation,attempt_state,provider_idempotency_hash,
           request_fingerprint,reconciliation_state,retain_until)
          VALUES ($1,$2,$3,$4,$5,$6,'PLANNED',$7,$8,'NOT_REQUIRED',$9)
          ON CONFLICT (tenant_id,logical_effect_key) DO NOTHING RETURNING attempt_state`, [input.tenantId, idFactory(),
          input.logicalEffectKey, input.eventId, input.deliveryId, input.operation, idempotencyHash, input.requestFingerprint,
          new Date(now().getTime() + retentionMilliseconds)]);
        if (!inserted.rowCount) {
          const found = await client.query("SELECT attempt_state,request_fingerprint FROM outbox.outbound_effect WHERE tenant_id=$1 AND logical_effect_key=$2 FOR UPDATE", [input.tenantId, input.logicalEffectKey]);
          if (!found.rows[0] || found.rows[0].request_fingerprint !== input.requestFingerprint) throw new Error("EFFECT_IDEMPOTENCY_MISMATCH");
          existingState = found.rows[0].attempt_state;
        }
        if (!existingState || existingState === "PLANNED") await client.query("UPDATE outbox.outbound_effect SET attempt_state='IN_FLIGHT',reconciliation_state='PENDING',updated_at=now() WHERE tenant_id=$1 AND logical_effect_key=$2", [input.tenantId, input.logicalEffectKey]);
        await client.query("COMMIT");
      } catch (error) { try { await client.query("ROLLBACK"); } catch { /* original failure wins */ } throw error; }
      finally { client.release(); }

      if (existingState === "SUCCEEDED" || existingState === "RECONCILED") return existingState;
      if (existingState === "MANUAL_REVIEW" || existingState === "PERMANENT_FAILURE") return existingState;
      if (existingState === "IN_FLIGHT") {
        if (!provider.supportsReconciliation || !provider.reconcile) {
          await update(input.tenantId, input.logicalEffectKey, "MANUAL_REVIEW", "UNAVAILABLE", "RECONCILIATION_UNAVAILABLE");
          return "MANUAL_REVIEW";
        }
        const reconciled = await provider.reconcile(idempotencyHash);
        if (reconciled.found && reconciled.providerReference) {
          await update(input.tenantId, input.logicalEffectKey, "RECONCILED", "CONFIRMED", "PROVIDER_CONFIRMED", reconciled.providerReference);
          return "RECONCILED";
        }
        if (!provider.supportsIdempotency) {
          await update(input.tenantId, input.logicalEffectKey, "MANUAL_REVIEW", "CONFIRMED", "PROVIDER_NOT_FOUND_RETRY_UNSAFE");
          return "MANUAL_REVIEW";
        }
      }
      try {
        const result = await provider.perform({ operation: input.operation, idempotencyKey: idempotencyHash, requestFingerprint: input.requestFingerprint });
        await update(input.tenantId, input.logicalEffectKey, "SUCCEEDED", "NOT_REQUIRED", "PROVIDER_SUCCEEDED", result.providerReference);
        return "SUCCEEDED";
      } catch (error) {
        if (error instanceof TransientProviderFailure) {
          await update(input.tenantId, input.logicalEffectKey, "PLANNED", "PENDING", "TRANSIENT_DEPENDENCY");
          throw error;
        }
        if (error instanceof PermanentProviderFailure) {
          await update(input.tenantId, input.logicalEffectKey, "PERMANENT_FAILURE", "NOT_REQUIRED", "PERMANENT_VALIDATION");
          return "PERMANENT_FAILURE";
        }
        if (!(error instanceof AmbiguousProviderOutcome)) throw error;
        if (provider.supportsReconciliation && provider.reconcile) {
          const reconciled = await provider.reconcile(idempotencyHash);
          if (reconciled.found && reconciled.providerReference) {
            await update(input.tenantId, input.logicalEffectKey, "RECONCILED", "CONFIRMED", "PROVIDER_CONFIRMED", reconciled.providerReference);
            return "RECONCILED";
          }
        }
        await update(input.tenantId, input.logicalEffectKey, "MANUAL_REVIEW", provider.supportsReconciliation ? "CONFIRMED" : "UNAVAILABLE", "AMBIGUOUS_EXTERNAL_OUTCOME");
        return "MANUAL_REVIEW";
      }
    },
  });
}

export function createFakeEffectProvider(mode: "SUCCESS" | "TRANSIENT_ONCE" | "PERMANENT" | "AMBIGUOUS_RECONCILABLE" | "AMBIGUOUS_UNSUPPORTED"): EffectProvider & { readonly calls: readonly string[] } {
  const calls: string[] = [];
  const completed = new Map<string, string>();
  return Object.freeze({
    supportsIdempotency: mode !== "AMBIGUOUS_UNSUPPORTED",
    supportsReconciliation: mode !== "AMBIGUOUS_UNSUPPORTED",
    calls,
    async perform(input: { readonly operation: string; readonly idempotencyKey: string }) {
      calls.push(input.idempotencyKey);
      const reference = `synthetic_provider_${hash(input.idempotencyKey).slice(0, 16)}`;
      if (mode === "SUCCESS") return { providerReference: reference };
      if (mode === "TRANSIENT_ONCE" && calls.length === 1) throw new TransientProviderFailure();
      if (mode === "TRANSIENT_ONCE") return { providerReference: reference };
      if (mode === "PERMANENT") throw new PermanentProviderFailure();
      if (mode === "AMBIGUOUS_RECONCILABLE") completed.set(input.idempotencyKey, reference);
      throw new AmbiguousProviderOutcome();
    },
    async reconcile(idempotencyKey: string) {
      const providerReference = completed.get(idempotencyKey);
      return providerReference ? { found: true, providerReference } : { found: false };
    },
  });
}
