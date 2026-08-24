import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { OutboxRoute } from "./contracts.js";
import { validateEventEnvelope, validateThinJobPayload } from "./contracts.js";
import type { FailureClass } from "./policies.js";
import { FAILURE_POLICIES, retryDelayMilliseconds } from "./policies.js";
import type { TransactionalTransport } from "./transport.js";

const retentionMilliseconds = 2_592_300_000;

export interface DeliveryLease {
  readonly tenantId: string;
  readonly deliveryId: string;
  readonly messageId: string;
  readonly route: OutboxRoute;
  readonly jobType: string;
  readonly leaseVersion: number;
  readonly publishAttempts: number;
  readonly leaseExpiresAt: string;
}

async function beginTenant(client: PoolClient, role: "kavaroutes_outbox_publisher" | "kavaroutes_outbox_consumer", tenantId: string): Promise<void> {
  await client.query("BEGIN");
  await client.query(`SET LOCAL ROLE ${role}`);
  await client.query("SELECT set_config('app.tenant_id',$1,true)", [tenantId]);
}

async function rollbackQuietly(client: PoolClient): Promise<void> {
  try { await client.query("ROLLBACK"); } catch { /* original failure is authoritative */ }
}

export function createOutboxStore(pool: Pool, options: { readonly now?: () => Date; readonly idFactory?: () => string; readonly workerVersion?: string } = {}) {
  const now = options.now ?? (() => new Date());
  const idFactory = options.idFactory ?? randomUUID;
  const workerVersion = options.workerVersion ?? "wp008.publisher-v1";
  return Object.freeze({
    async claimEligible(input: { tenantId: string; publisherId: string; route: OutboxRoute; limit: number; leaseMilliseconds: number }): Promise<readonly DeliveryLease[]> {
      if (!/^[a-z][a-z0-9._-]{2,63}$/.test(input.publisherId) || !Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100 || input.leaseMilliseconds < 1_000 || input.leaseMilliseconds > 300_000) throw new Error("INVALID_CLAIM_BOUNDS");
      const client = await pool.connect();
      try {
        await beginTenant(client, "kavaroutes_outbox_publisher", input.tenantId);
        const claimed = await client.query(`WITH candidates AS (
          SELECT d.tenant_id,d.id,d.status FROM outbox.delivery d
          LEFT JOIN outbox.route_control c ON c.tenant_id=d.tenant_id AND c.route=d.route
          WHERE d.tenant_id=$1 AND d.route=$2
            AND COALESCE(c.paused,false)=false AND COALESCE(c.kill_switch,false)=false
            AND ((d.status='PENDING' AND d.available_at<=now()) OR (d.status='LEASED' AND d.lease_expires_at<=now()))
          ORDER BY d.available_at,d.id FOR UPDATE OF d SKIP LOCKED LIMIT $3
        ) UPDATE outbox.delivery d SET status='LEASED',lease_owner=$4,
          lease_expires_at=now()+($5::int*interval '1 millisecond'),lease_version=d.lease_version+1,
          publish_attempts=d.publish_attempts+1,lifecycle_version=d.lifecycle_version+1
          FROM candidates c WHERE d.tenant_id=c.tenant_id AND d.id=c.id
          RETURNING d.id,d.message_id,d.route,d.job_type,d.lease_version,d.publish_attempts,d.lease_expires_at,c.status AS prior_status`,
        [input.tenantId, input.route, input.limit, input.publisherId, input.leaseMilliseconds]);
        for (const row of claimed.rows) {
          await client.query(`INSERT INTO outbox.delivery_attempt
            (tenant_id,id,delivery_id,attempt_number,attempt_kind,outcome,worker_version,retain_until)
            VALUES ($1,$2,$3,$4,$5,'LEASED',$6,$7)`, [input.tenantId, idFactory(), row.id, row.publish_attempts,
            row.prior_status === "LEASED" ? "RECLAIM" : "CLAIM", workerVersion, new Date(now().getTime() + retentionMilliseconds)]);
        }
        await client.query("COMMIT");
        return claimed.rows.map((row) => Object.freeze({ tenantId: input.tenantId, deliveryId: row.id, messageId: row.message_id,
          route: row.route as OutboxRoute, jobType: row.job_type, leaseVersion: Number(row.lease_version),
          publishAttempts: Number(row.publish_attempts), leaseExpiresAt: new Date(row.lease_expires_at).toISOString() }));
      } catch (error) {
        await rollbackQuietly(client);
        throw error;
      } finally { client.release(); }
    },

    async publishLeased(input: { tenantId: string; publisherId: string; deliveryId: string; leaseVersion: number }, transport: TransactionalTransport): Promise<{ readonly transportReference: string; readonly duplicate: boolean }> {
      if (!transport.supportsAtomicEnrollment) throw new Error("NON_TRANSACTIONAL_TRANSPORT_REJECTED");
      const client = await pool.connect();
      try {
        await beginTenant(client, "kavaroutes_outbox_publisher", input.tenantId);
        const selected = await client.query(`SELECT d.id,d.route,d.job_type,d.lease_owner,d.lease_version,d.status,d.publish_attempts,
          m.event_id,m.aggregate_type,m.aggregate_id,m.aggregate_version,m.event_type,m.schema_version,m.occurred_at,
          m.command_id,m.idempotency_reference_hash,m.correlation_id,m.causation_id,m.source,m.classification_reference,
          m.purpose_reference,m.policy_reference,m.payload
          FROM outbox.delivery d JOIN outbox.message m ON m.tenant_id=d.tenant_id AND m.id=d.message_id
          WHERE d.tenant_id=$1 AND d.id=$2 FOR UPDATE OF d`, [input.tenantId, input.deliveryId]);
        const row = selected.rows[0];
        if (!row || row.status !== "LEASED" || row.lease_owner !== input.publisherId || Number(row.lease_version) !== input.leaseVersion) throw new Error("STALE_DELIVERY_LEASE");
        validateEventEnvelope({ eventId: row.event_id, aggregateType: row.aggregate_type, aggregateId: row.aggregate_id,
          aggregateVersion: Number(row.aggregate_version), eventType: row.event_type, schemaVersion: row.schema_version,
          occurredAt: new Date(row.occurred_at).toISOString(), commandId: row.command_id,
          idempotencyReferenceHash: row.idempotency_reference_hash, correlationId: row.correlation_id,
          ...(row.causation_id ? { causationId: row.causation_id } : {}), source: row.source,
          classificationReference: row.classification_reference, purposeReference: row.purpose_reference,
          policyReference: row.policy_reference, payload: row.payload });
        const payload = validateThinJobPayload({ tenantId: input.tenantId, deliveryId: row.id, eventId: row.event_id,
          route: row.route, jobType: row.job_type, eventType: row.event_type, schemaVersion: row.schema_version,
          aggregateType: row.aggregate_type, aggregateId: row.aggregate_id, aggregateVersion: Number(row.aggregate_version),
          correlationId: row.correlation_id, ...(row.causation_id ? { causationId: row.causation_id } : {}),
          classificationReference: row.classification_reference, purposeReference: row.purpose_reference, policyReference: row.policy_reference });
        const enrolled = await transport.send(client, payload);
        await client.query(`UPDATE outbox.delivery SET status='PUBLISHED',lease_owner=NULL,lease_expires_at=NULL,
          transport_reference=$1,first_published_at=COALESCE(first_published_at,now()),last_published_at=now(),
          lifecycle_version=lifecycle_version+1 WHERE tenant_id=$2 AND id=$3`, [enrolled.transportReference, input.tenantId, input.deliveryId]);
        await client.query(`INSERT INTO outbox.delivery_attempt
          (tenant_id,id,delivery_id,attempt_number,attempt_kind,outcome,worker_version,retain_until)
          VALUES ($1,$2,$3,$4,'PUBLISH','COMMITTED',$5,$6)`, [input.tenantId, idFactory(), input.deliveryId,
          Number(row.publish_attempts), workerVersion, new Date(now().getTime() + retentionMilliseconds)]);
        await client.query("COMMIT");
        return enrolled;
      } catch (error) {
        await rollbackQuietly(client);
        throw error;
      } finally { client.release(); }
    },

    async failLeased(input: { tenantId: string; publisherId: string; deliveryId: string; leaseVersion: number; failureClass: FailureClass }): Promise<"RETRY_SCHEDULED" | "DEAD_LETTERED" | "BLOCKED"> {
      const client = await pool.connect();
      try {
        await beginTenant(client, "kavaroutes_outbox_publisher", input.tenantId);
        const current = await client.query("SELECT status,lease_owner,lease_version,publish_attempts FROM outbox.delivery WHERE tenant_id=$1 AND id=$2 FOR UPDATE", [input.tenantId, input.deliveryId]);
        const row = current.rows[0];
        if (!row || row.status !== "LEASED" || row.lease_owner !== input.publisherId || Number(row.lease_version) !== input.leaseVersion) throw new Error("STALE_DELIVERY_LEASE");
        const policy = FAILURE_POLICIES[input.failureClass];
        const delay = retryDelayMilliseconds(input.failureClass, Number(row.publish_attempts));
        const next = delay !== null ? "PENDING" : policy.terminalAction === "BLOCK" ? "BLOCKED" : "DEAD_LETTERED";
        const outcome = next === "PENDING" ? "RETRY_SCHEDULED" : next;
        await client.query(`UPDATE outbox.delivery SET status=$1,lease_owner=NULL,lease_expires_at=NULL,
          available_at=CASE WHEN $1='PENDING' THEN now()+($2::int*interval '1 millisecond') ELSE available_at END,
          safe_failure_code=$3,dead_lettered_at=CASE WHEN $1='DEAD_LETTERED' THEN now() ELSE NULL END,
          lifecycle_version=lifecycle_version+1 WHERE tenant_id=$4 AND id=$5`, [next, delay ?? 0, input.failureClass, input.tenantId, input.deliveryId]);
        await client.query(`INSERT INTO outbox.delivery_attempt
          (tenant_id,id,delivery_id,attempt_number,attempt_kind,outcome,safe_error_class,worker_version,retain_until)
          VALUES ($1,$2,$3,$4,'FAIL',$5,$6,$7,$8)`, [input.tenantId, idFactory(), input.deliveryId,
          Number(row.publish_attempts), outcome, input.failureClass, workerVersion, new Date(now().getTime() + retentionMilliseconds)]);
        await client.query("COMMIT");
        return outcome as "RETRY_SCHEDULED" | "DEAD_LETTERED" | "BLOCKED";
      } catch (error) {
        await rollbackQuietly(client);
        throw error;
      } finally { client.release(); }
    },

    async routeHealth(tenantId: string, route: OutboxRoute): Promise<{ readonly depth: number; readonly oldestAgeSeconds: number; readonly leased: number; readonly deadLettered: number }> {
      const client = await pool.connect();
      try {
        await beginTenant(client, "kavaroutes_outbox_publisher", tenantId);
        const result = await client.query(`SELECT count(*) FILTER (WHERE status IN ('PENDING','LEASED'))::int AS depth,
          COALESCE(EXTRACT(epoch FROM now()-min(created_at) FILTER (WHERE status IN ('PENDING','LEASED'))),0)::int AS oldest_age_seconds,
          count(*) FILTER (WHERE status='LEASED')::int AS leased,count(*) FILTER (WHERE status='DEAD_LETTERED')::int AS dead_lettered
          FROM outbox.delivery WHERE tenant_id=$1 AND route=$2`, [tenantId, route]);
        await client.query("COMMIT");
        return { depth: result.rows[0].depth, oldestAgeSeconds: result.rows[0].oldest_age_seconds, leased: result.rows[0].leased, deadLettered: result.rows[0].dead_lettered };
      } catch (error) { await rollbackQuietly(client); throw error; } finally { client.release(); }
    },
  });
}
