import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type { OutboxRoute } from "./contracts.js";

export interface ReplayAuthorization {
  authorize(input: { readonly tenantId: string; readonly actorReference: string; readonly action: "ROUTE_CONTROL" | "REPLAY_PLAN" | "REPLAY_EXECUTE" }): Promise<boolean>;
}

export function createReplayService(pool: Pool, authorization: ReplayAuthorization, idFactory: () => string = randomUUID) {
  async function authorized(tenantId: string, actorReference: string, action: "ROUTE_CONTROL" | "REPLAY_PLAN" | "REPLAY_EXECUTE"): Promise<void> {
    if (!(await authorization.authorize({ tenantId, actorReference, action }))) throw new Error("REPLAY_AUTHORIZATION_DENIED");
  }
  return Object.freeze({
    async setRouteControl(input: { tenantId: string; route: OutboxRoute; paused: boolean; killSwitch: boolean; reasonCode: string; actorReference: string }): Promise<void> {
      await authorized(input.tenantId, input.actorReference, "ROUTE_CONTROL");
      const client = await pool.connect();
      try {
        await client.query("BEGIN"); await client.query("SET LOCAL ROLE kavaroutes_outbox_consumer");
        await client.query("SELECT set_config('app.tenant_id',$1,true)", [input.tenantId]);
        await client.query(`INSERT INTO outbox.route_control (tenant_id,route,paused,kill_switch,reason_code,actor_reference)
          VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (tenant_id,route) DO UPDATE SET paused=EXCLUDED.paused,
          kill_switch=EXCLUDED.kill_switch,reason_code=EXCLUDED.reason_code,actor_reference=EXCLUDED.actor_reference,updated_at=now()`,
        [input.tenantId, input.route, input.paused, input.killSwitch, input.reasonCode, input.actorReference]);
        await client.query("COMMIT");
      } catch (error) { try { await client.query("ROLLBACK"); } catch { /* original wins */ } throw error; } finally { client.release(); }
    },

    async plan(input: { tenantId: string; route: OutboxRoute; eventId?: string; from?: Date; to?: Date; limit: number; sideEffectClass: "INTERNAL" | "EXTERNAL_IDEMPOTENT" | "EXTERNAL_AMBIGUOUS"; reasonCode: string; actorReference: string }): Promise<{ readonly replayId: string; readonly candidateCount: number; readonly costUnits: number; readonly schemaCompatibility: "COMPATIBLE_REGISTERED_VERSIONS_ONLY"; readonly sideEffectClass: string }> {
      await authorized(input.tenantId, input.actorReference, "REPLAY_PLAN");
      if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 1000) throw new Error("INVALID_REPLAY_BOUND");
      const replayId = idFactory();
      const client = await pool.connect();
      try {
        await client.query("BEGIN"); await client.query("SET LOCAL ROLE kavaroutes_outbox_consumer");
        await client.query("SELECT set_config('app.tenant_id',$1,true)", [input.tenantId]);
        const result = await client.query(`SELECT count(*)::int AS count FROM (SELECT d.id FROM outbox.delivery d
          JOIN outbox.message m ON m.tenant_id=d.tenant_id AND m.id=d.message_id
          WHERE d.tenant_id=$1 AND d.route=$2 AND d.status='DEAD_LETTERED'
            AND ($3::uuid IS NULL OR m.event_id=$3) AND ($4::timestamptz IS NULL OR m.recorded_at >= $4)
            AND ($5::timestamptz IS NULL OR m.recorded_at <= $5) ORDER BY d.id LIMIT $6) candidates`,
        [input.tenantId, input.route, input.eventId ?? null, input.from ?? null, input.to ?? null, input.limit]);
        const candidateCount = Number(result.rows[0].count);
        const costUnits = candidateCount * (input.sideEffectClass === "INTERNAL" ? 1 : input.sideEffectClass === "EXTERNAL_IDEMPOTENT" ? 5 : 20);
        await client.query(`INSERT INTO outbox.replay_operation
          (tenant_id,id,route,event_id,from_recorded_at,to_recorded_at,dry_run,candidate_count,side_effect_class,cost_units,
           reason_code,actor_reference,status,rate_limit_per_minute) VALUES ($1,$2,$3,$4,$5,$6,true,$7,$8,$9,$10,$11,'PLANNED',$12)`,
        [input.tenantId, replayId, input.route, input.eventId ?? null, input.from ?? null, input.to ?? null,
          candidateCount, input.sideEffectClass, costUnits, input.reasonCode, input.actorReference, Math.min(input.limit, 1000)]);
        await client.query("COMMIT");
        return { replayId, candidateCount, costUnits, schemaCompatibility: "COMPATIBLE_REGISTERED_VERSIONS_ONLY", sideEffectClass: input.sideEffectClass };
      } catch (error) { try { await client.query("ROLLBACK"); } catch { /* original wins */ } throw error; } finally { client.release(); }
    },

    async execute(input: { tenantId: string; replayId: string; actorReference: string; batchSize: number }): Promise<{ readonly redriven: number; readonly completed: boolean }> {
      await authorized(input.tenantId, input.actorReference, "REPLAY_EXECUTE");
      if (!Number.isInteger(input.batchSize) || input.batchSize < 1 || input.batchSize > 100) throw new Error("INVALID_REDRIVE_BOUND");
      const client = await pool.connect();
      try {
        await client.query("BEGIN"); await client.query("SET LOCAL ROLE kavaroutes_outbox_consumer");
        await client.query("SELECT set_config('app.tenant_id',$1,true)", [input.tenantId]);
        const replay = await client.query("SELECT * FROM outbox.replay_operation WHERE tenant_id=$1 AND id=$2 FOR UPDATE", [input.tenantId, input.replayId]);
        const row = replay.rows[0];
        if (!row || !["PLANNED", "RUNNING"].includes(row.status)) throw new Error("REPLAY_NOT_EXECUTABLE");
        const control = await client.query("SELECT paused,kill_switch FROM outbox.route_control WHERE tenant_id=$1 AND route=$2", [input.tenantId, row.route]);
        if (control.rows[0]?.kill_switch || control.rows[0]?.paused) throw new Error("REPLAY_ROUTE_STOPPED");
        const selected = await client.query(`SELECT d.id,d.publish_attempts,prior.id AS original_attempt_id FROM outbox.delivery d JOIN outbox.message m
          ON m.tenant_id=d.tenant_id AND m.id=d.message_id JOIN LATERAL
          (SELECT a.id FROM outbox.delivery_attempt a WHERE a.tenant_id=d.tenant_id AND a.delivery_id=d.id ORDER BY a.occurred_at DESC,a.id DESC LIMIT 1) prior ON true
          WHERE d.tenant_id=$1 AND d.route=$2 AND d.status='DEAD_LETTERED'
          AND ($3::uuid IS NULL OR m.event_id=$3) AND ($4::timestamptz IS NULL OR m.recorded_at >= $4)
          AND ($5::timestamptz IS NULL OR m.recorded_at <= $5) AND ($6::uuid IS NULL OR d.id>$6)
          ORDER BY d.id FOR UPDATE OF d SKIP LOCKED LIMIT $7`, [input.tenantId, row.route, row.event_id,
          row.from_recorded_at, row.to_recorded_at, row.checkpoint_delivery_id, input.batchSize]);
        for (const delivery of selected.rows) {
          await client.query(`UPDATE outbox.delivery SET status='PENDING',available_at=now(),lease_owner=NULL,lease_expires_at=NULL,
            dead_lettered_at=NULL,safe_failure_code=NULL,lifecycle_version=lifecycle_version+1 WHERE tenant_id=$1 AND id=$2`, [input.tenantId, delivery.id]);
          await client.query(`INSERT INTO outbox.delivery_attempt
            (tenant_id,id,delivery_id,attempt_number,attempt_kind,outcome,worker_version,original_attempt_id,retain_until)
            VALUES ($1,$2,$3,$4,'REDRIVE','RETRY_SCHEDULED','wp008.replay-v1',$5,now()+interval '30 days 5 minutes')`,
          [input.tenantId, idFactory(), delivery.id, Number(delivery.publish_attempts) + 1, delivery.original_attempt_id]);
        }
        const redriven = selected.rowCount ?? 0;
        const completed = redriven < input.batchSize;
        const checkpoint = selected.rows.at(-1)?.id ?? row.checkpoint_delivery_id;
        await client.query(`UPDATE outbox.replay_operation SET dry_run=false,status=$1,checkpoint_delivery_id=$2,updated_at=now()
          WHERE tenant_id=$3 AND id=$4`, [completed ? "COMPLETED" : "RUNNING", checkpoint, input.tenantId, input.replayId]);
        await client.query("COMMIT");
        return { redriven, completed };
      } catch (error) { try { await client.query("ROLLBACK"); } catch { /* original wins */ } throw error; } finally { client.release(); }
    },
  });
}
