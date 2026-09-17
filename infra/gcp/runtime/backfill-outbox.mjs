import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { createRecovery } from './recovery.mjs';
import { readConfig } from './config.mjs';

/**
 * Operator tool: re-queue outbox deliveries whose consumer never recorded the event.
 *
 * A published delivery is normally finished, and a replay targets its transport job. That
 * breaks when the job is gone — dead-lettered and cleared, or deleted during incident
 * recovery — and the consumer never applied the event, which leaves the read model behind
 * forever (audit WEB-A-031). This tool finds those deliveries, and with `--apply` runs the
 * authorized, journalled recovery backfill that returns each one to PENDING so the
 * ordinary publisher re-creates the job. Dry-run unless `--apply` is passed.
 *
 * Invocation (from the runtime image or a checkout with its own config file):
 *   node infra/gcp/runtime/backfill-outbox.mjs --config /run/secrets/config.json \
 *     --tenant <uuid> [--delivery <uuid>] [--actor cloud.operator.backfill] [--apply]
 */
const args = process.argv.slice(2);
const flag = name => { const index = args.indexOf(`--${name}`); return index >= 0 ? args[index + 1] : undefined; };
const apply = args.includes('--apply');
const configPath = flag('config'), tenant = flag('tenant'), delivery = flag('delivery');
const actor = flag('actor') ?? 'cloud.operator.backfill';
if (!configPath || !tenant || !/^[0-9a-f-]{36}$/.test(tenant) || !/^[a-z][a-z0-9._:-]{2,95}$/.test(actor) ||
    (delivery !== undefined && !/^[0-9a-f-]{36}$/.test(delivery))) { console.error(JSON.stringify({ code: 'BACKFILL_ARGUMENTS_REQUIRED' })); process.exit(2); }
const config = await readConfig(configPath, 'worker');
const pool = new Pool({ connectionString: config.databaseUrl, max: 2, application_name: 'kavaroutes-backfill' });
pool.on('error', () => {});
// The backfill path never touches pg-boss: it re-queues the delivery and lets the worker's
// own publisher create the job.
const recovery = createRecovery(pool, { retry: async () => { throw new Error('BACKFILL_BOSS_UNUSED'); } },
  async input => input.actorReference === actor);
try {
  const client = await pool.connect();
  let candidates;
  try {
    await client.query('BEGIN');
    // The scan reads the route consumers' own tables, so it runs with the consumer role
    // (the worker role has no USAGE on the realtime schema).
    await client.query('SET LOCAL ROLE kavaroutes_outbox_consumer');
    await client.query("SELECT set_config('app.tenant_id',$1,true)", [tenant]);
    candidates = (await client.query(`SELECT d.id,d.route,d.status FROM outbox.delivery d
      WHERE d.tenant_id=$1 AND d.status IN ('PUBLISHED','DEAD_LETTERED')
        AND ((d.route='projection' AND NOT EXISTS (SELECT 1 FROM outbox.consumer_inbox i
                WHERE i.tenant_id=d.tenant_id AND i.consumer_name='projection.trip'
                  AND i.event_id=(SELECT m.event_id FROM outbox.message m WHERE m.tenant_id=d.tenant_id AND m.id=d.message_id)))
          OR (d.route='realtime-signal' AND NOT EXISTS (SELECT 1 FROM realtime.consumer_checkpoint c
                WHERE c.tenant_id=d.tenant_id AND c.consumer_name='realtime.v1'
                  AND c.source_event_id=(SELECT m.event_id FROM outbox.message m WHERE m.tenant_id=d.tenant_id AND m.id=d.message_id))))
        ${delivery ? 'AND d.id=$2' : ''}
      ORDER BY d.updated_at,d.id LIMIT 200`, delivery ? [tenant, delivery] : [tenant])).rows;
    await client.query('COMMIT');
  } finally { client.release(); }
  const results = [];
  for (const row of candidates) {
    if (!apply) { results.push({ deliveryId: row.id, route: row.route, status: 'CANDIDATE' }); continue; }
    try {
      const outcome = await recovery.backfill({ tenantId: tenant, deliveryId: row.id, requestId: randomUUID(),
        actorReference: actor, reasonCode: 'OPERATOR_REVIEWED' }, [tenant]);
      results.push({ deliveryId: row.id, route: row.route, status: outcome.status });
    } catch (error) { results.push({ deliveryId: row.id, route: row.route, status: 'REFUSED', code: error.message }); }
  }
  console.log(JSON.stringify({ mode: apply ? 'APPLIED' : 'DRY_RUN', tenant, candidates: candidates.length, results }));
} catch (error) {
  console.error(JSON.stringify({ code: error?.message ?? 'BACKFILL_FAILED' })); process.exitCode = 1;
} finally { await pool.end(); }
