import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type { ThinJobPayload } from "./contracts.js";
import { validateEventEnvelope, validateThinJobPayload } from "./contracts.js";

const retentionMilliseconds = 2_592_300_000;

export class AggregateGapError extends Error {
  readonly expectedVersion: number;
  readonly receivedVersion: number;
  constructor(expectedVersion: number, receivedVersion: number) {
    super("AGGREGATE_VERSION_GAP");
    this.name = "AggregateGapError";
    this.expectedVersion = expectedVersion;
    this.receivedVersion = receivedVersion;
  }
}

export function createOrderedConsumer(pool: Pool, options: { readonly consumerName: string; readonly purposeReference: string;
  readonly authorize: (input: { readonly tenantId: string; readonly purposeReference: string; readonly consumerName: string }) => Promise<boolean>;
  readonly handlerVersion?: string; readonly idFactory?: () => string; readonly now?: () => Date }) {
  if (!/^[a-z][a-z0-9.-]{2,63}$/.test(options.consumerName)) throw new Error("INVALID_CONSUMER_NAME");
  const handlerVersion = options.handlerVersion ?? "v1";
  const idFactory = options.idFactory ?? randomUUID;
  const now = options.now ?? (() => new Date());
  return Object.freeze({
    async consume(unsafePayload: unknown, control: { readonly failBeforeCommit?: boolean; readonly failAfterCommit?: boolean } = {}): Promise<"APPLIED" | "DUPLICATE" | "OBSOLETE"> {
      const payload: ThinJobPayload = validateThinJobPayload(unsafePayload);
      if (payload.purposeReference !== options.purposeReference || !(await options.authorize({ tenantId: payload.tenantId, purposeReference: options.purposeReference, consumerName: options.consumerName }))) throw new Error("CONSUMER_AUTHORIZATION_DENIED");
      const client = await pool.connect();
      let outcome: "APPLIED" | "DUPLICATE" | "OBSOLETE" = "APPLIED";
      try {
        await client.query("BEGIN");
        await client.query("SET LOCAL ROLE kavaroutes_outbox_consumer");
        await client.query("SELECT set_config('app.tenant_id',$1,true)", [payload.tenantId]);
        await client.query("SELECT set_config('app.purpose_reference',$1,true)", [options.purposeReference]);
        const messageResult = await client.query(`SELECT m.* FROM outbox.delivery d JOIN outbox.message m
          ON m.tenant_id=d.tenant_id AND m.id=d.message_id WHERE d.tenant_id=$1 AND d.id=$2 AND m.event_id=$3`,
        [payload.tenantId, payload.deliveryId, payload.eventId]);
        const message = messageResult.rows[0];
        if (!message) throw new Error("MESSAGE_REFERENCE_NOT_FOUND");
        validateEventEnvelope({ eventId: message.event_id, aggregateType: message.aggregate_type, aggregateId: message.aggregate_id,
          aggregateVersion: Number(message.aggregate_version), eventType: message.event_type, schemaVersion: message.schema_version,
          occurredAt: new Date(message.occurred_at).toISOString(), commandId: message.command_id,
          idempotencyReferenceHash: message.idempotency_reference_hash, correlationId: message.correlation_id,
          ...(message.causation_id ? { causationId: message.causation_id } : {}), source: message.source,
          classificationReference: message.classification_reference, purposeReference: message.purpose_reference,
          policyReference: message.policy_reference, payload: message.payload });
        const duplicate = await client.query("SELECT 1 FROM outbox.consumer_inbox WHERE tenant_id=$1 AND consumer_name=$2 AND event_id=$3", [payload.tenantId, options.consumerName, message.event_id]);
        if (duplicate.rowCount) {
          outcome = "DUPLICATE";
        } else {
          await client.query(`INSERT INTO outbox.consumer_checkpoint (tenant_id,consumer_name,aggregate_type,aggregate_id)
            VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`, [payload.tenantId, options.consumerName, message.aggregate_type, message.aggregate_id]);
          const checkpoint = await client.query(`SELECT last_applied_version FROM outbox.consumer_checkpoint
            WHERE tenant_id=$1 AND consumer_name=$2 AND aggregate_type=$3 AND aggregate_id=$4 FOR UPDATE`,
          [payload.tenantId, options.consumerName, message.aggregate_type, message.aggregate_id]);
          const last = Number(checkpoint.rows[0].last_applied_version);
          const received = Number(message.aggregate_version);
          if (received > last + 1) throw new AggregateGapError(last + 1, received);
          outcome = received <= last ? "OBSOLETE" : "APPLIED";
          if (outcome === "APPLIED") {
            const lifecycle = String((message.payload as Record<string, unknown>).lifecycle);
            await client.query(`INSERT INTO outbox.consumer_projection
              (tenant_id,consumer_name,aggregate_type,aggregate_id,applied_version,safe_state)
              VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (tenant_id,consumer_name,aggregate_type,aggregate_id)
              DO UPDATE SET applied_version=EXCLUDED.applied_version,safe_state=EXCLUDED.safe_state,updated_at=now()`,
            [payload.tenantId, options.consumerName, message.aggregate_type, message.aggregate_id, received, lifecycle]);
            await client.query(`UPDATE outbox.consumer_checkpoint SET last_applied_version=$1,updated_at=now()
              WHERE tenant_id=$2 AND consumer_name=$3 AND aggregate_type=$4 AND aggregate_id=$5`,
            [received, payload.tenantId, options.consumerName, message.aggregate_type, message.aggregate_id]);
          }
          await client.query(`INSERT INTO outbox.consumer_inbox
            (tenant_id,id,consumer_name,event_id,aggregate_type,aggregate_id,aggregate_version,processing_state,
             handler_version,schema_version,safe_result_reference,retain_until)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`, [payload.tenantId, idFactory(), options.consumerName,
            message.event_id, message.aggregate_type, message.aggregate_id, received, outcome === "OBSOLETE" ? "OBSOLETE" : "COMPLETED",
            handlerVersion, message.schema_version, `ref_${message.event_id.replaceAll("-", "")}`, new Date(now().getTime() + retentionMilliseconds)]);
        }
        if (control.failBeforeCommit) throw new Error("SYNTHETIC_HANDLER_BEFORE_COMMIT");
        await client.query("COMMIT");
      } catch (error) {
        try { await client.query("ROLLBACK"); } catch { /* original failure is authoritative */ }
        throw error;
      } finally { client.release(); }
      if (control.failAfterCommit) throw new Error("SYNTHETIC_HANDLER_ACK_LOST");
      return outcome;
    },
  });
}
