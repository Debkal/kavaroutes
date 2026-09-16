import { randomUUID } from 'node:crypto';
import { validateThinJobPayload, ROUTE_POLICIES } from '@kavaroutes/durable-execution';
import { schema, tenantId, routes, retryDue, retryableJob } from './config.mjs';

// Transport-consumption decisions are separate from successful outbox publication.
// Journal writes and pg-boss retry enrollment commit on one database connection.
export function createRecovery(pool, boss, authorizeReplay = async () => false) {
  async function transaction(operation) {
    const client = await pool.connect();
    try { await client.query('BEGIN'); const result = await operation(client); await client.query('COMMIT'); return result; }
    catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }
  async function bind(client, job, queue) {
    const payload = validateThinJobPayload(job.data);
    if (payload.tenantId !== tenantId || !routes.includes(payload.route) || ROUTE_POLICIES[payload.route].queue !== queue) throw new Error('RECOVERY_SCOPE_DENIED');
    await client.query('SET LOCAL ROLE kavaroutes_outbox_consumer');
    await client.query("SELECT set_config('app.tenant_id',$1,true)", [tenantId]);
    const source = await client.query(`SELECT 1 FROM outbox.delivery d JOIN outbox.message m ON m.tenant_id=d.tenant_id AND m.id=d.message_id
      WHERE d.tenant_id=$1 AND d.id=$2 AND d.route=$3 AND m.event_id=$4 AND m.aggregate_id=$5 AND m.aggregate_version=$6`,
    [tenantId, payload.deliveryId, payload.route, payload.eventId, payload.aggregateId, payload.aggregateVersion]);
    if (!source.rowCount) throw new Error('RECOVERY_SOURCE_MISMATCH');
    return payload;
  }
  async function append(client, job, payload, action, code, actor, id = randomUUID()) {
    await client.query(`INSERT INTO outbox.consumer_transport_journal
      (tenant_id,id,delivery_id,transport_id,transport_attempt,action,safe_code,actor_reference)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [tenantId,id,payload.deliveryId,job.id,job.retry_count,action,code,actor]);
  }
  async function retry(client, queue, id) {
    await client.query('RESET ROLE');
    await boss.retry(queue, id, { db: { executeSql: (sql, values) => client.query(sql, values) } });
  }
  return {
    async reconcile(queue) {
      if (!routes.some(route => ROUTE_POLICIES[route].queue === queue)) throw new Error('RECOVERY_SCOPE_DENIED');
      return transaction(async client => {
        // Filter already terminal and not-yet-due rows before LIMIT: poison jobs
        // cannot occupy the first 50 slots forever and starve eligible retries.
        await client.query("SELECT set_config('app.tenant_id',$1,true)", [tenantId]);
        const selected = await client.query(`SELECT * FROM ${schema}.job j WHERE name=$1 AND state='failed'
          AND NOT EXISTS (SELECT 1 FROM outbox.consumer_transport_journal t
            WHERE t.tenant_id=$2 AND t.transport_id=j.id AND t.transport_attempt=j.retry_count AND t.action='DEAD_LETTER')
          AND completed_on <= now() - (LEAST(300,power(2,LEAST(retry_count+1,9))) * interval '1 second')
          ORDER BY completed_on,id FOR UPDATE OF j SKIP LOCKED LIMIT 50`, [queue, tenantId]);
        for (const job of selected.rows) {
          const payload = await bind(client, job, queue);
          const due = retryDue(job);
          const code = due ? (job.output?.code === 'DATABASE_CONCURRENCY' ? 'DATABASE_CONCURRENCY' : 'TRANSIENT_DEPENDENCY')
            : retryableJob(job) ? 'RETRY_EXHAUSTED' : 'PERMANENT_VALIDATION';
          await append(client, job, payload, due ? 'RETRY' : 'DEAD_LETTER', code, 'cloud.reconciler');
          if (due) await retry(client, queue, job.id);
          else await client.query('RESET ROLE');
        }
        const remaining = await client.query(`SELECT EXISTS(SELECT 1 FROM ${schema}.job WHERE name=$1 AND state='failed') AS failed`, [queue]);
        return { processed: selected.rowCount, unresolved: remaining.rows[0].failed };
      });
    },
    async replay(input) {
      if (!input || !/^[a-z][a-z0-9._:-]{2,95}$/.test(input.actorReference ?? '') ||
          !/^[0-9a-f-]{36}$/.test(input.requestId ?? '') || input.tenantId !== tenantId || input.reasonCode !== 'OPERATOR_REVIEWED' ||
          !routes.some(route => ROUTE_POLICIES[route].queue === input.queue) || !(await authorizeReplay(input))) throw new Error('REPLAY_AUTHORIZATION_DENIED');
      return transaction(async client => {
        const job = (await client.query(`SELECT * FROM ${schema}.job WHERE name=$1 AND id=$2 FOR UPDATE`, [input.queue,input.jobId])).rows[0];
        if (!job) throw new Error('REPLAY_NOT_FOUND');
        const payload = await bind(client, job, input.queue);
        const prior = (await client.query('SELECT transport_id,actor_reference FROM outbox.consumer_transport_journal WHERE tenant_id=$1 AND id=$2', [tenantId,input.requestId])).rows[0];
        if (prior) {
          if (prior.transport_id !== job.id || prior.actor_reference !== input.actorReference) throw new Error('REPLAY_IDEMPOTENCY_MISMATCH');
          return 'REPLAYED';
        }
        const control = (await client.query('SELECT paused,kill_switch FROM outbox.route_control WHERE tenant_id=$1 AND route=$2 FOR SHARE', [tenantId,payload.route])).rows[0];
        if (control?.paused || control?.kill_switch) throw new Error('REPLAY_ROUTE_STOPPED');
        const terminal = await client.query("SELECT 1 FROM outbox.consumer_transport_journal WHERE tenant_id=$1 AND transport_id=$2 AND transport_attempt=$3 AND action='DEAD_LETTER'", [tenantId,job.id,job.retry_count]);
        if (job.state !== 'failed' || !terminal.rowCount) throw new Error('REPLAY_NOT_TERMINAL');
        await append(client, job, payload, 'REPLAY', input.reasonCode, input.actorReference, input.requestId);
        await retry(client, input.queue, job.id);
        return 'ENROLLED';
      });
    },
  };
}
