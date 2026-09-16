import { randomUUID } from 'node:crypto';
import { createOutboxStore, createPgBossTransactionalTransport, createOrderedConsumer, ROUTE_POLICIES, validateThinJobPayload } from '@kavaroutes/durable-execution';
import { createTestOnlyCursorCodec } from '@kavaroutes/realtime';
import { createPostgresRealtimeStore } from '@kavaroutes/realtime/postgres';
import { makePool, makeBoss, verifyRuntimeDatabase } from './database.mjs';
import { branchScopeReference, routes, validateConfig, classifyFailure, enrollmentBound } from './config.mjs';
import { createRecovery } from './recovery.mjs';
import {createWorkerTenantReader,reconcileTrackingAlerts} from '@kavaroutes/postgres-persistence';

export async function createRuntimeWorker(input) {
  const config = validateConfig(input);
  if (new URL(config.databaseUrl).username !== 'kr_cloud_worker') throw new Error('RUNTIME_DATABASE_ROLE_INVALID');
  const pool = makePool(config);
  const boss = makeBoss(pool);
  const outbox = createOutboxStore(pool);
  const transport = createPgBossTransactionalTransport(boss);
  const recovery = createRecovery(pool, boss);
  const tenants = createWorkerTenantReader(pool);
  // Enrollment is refreshed each cycle; jobs for an unenrolled tenant are refused
  // instead of being processed by accident.
  let enrolled = new Set();
  const consumer = createOrderedConsumer(pool, { consumerName: 'projection.trip', purposeReference: 'RIDER_INTAKE',
    authorize: async input => enrolled.has(input.tenantId) });
  const realtime = createPostgresRealtimeStore(pool, createTestOnlyCursorCodec({ secret: config.cursorSecret }));
  const publisherId = `cloud.${randomUUID()}`;
  let lastSuccess = 0;
  let inFlight;
  let stopped = false;
  let timer;
  let lastTrackingEvaluation=0;
  try { await verifyRuntimeDatabase(pool, 'worker'); await boss.start(); }
  catch (error) { await boss.stop(); await pool.end(); throw error; }

  async function consume(payload) {
    validateThinJobPayload(payload);
    if (!enrolled.has(payload.tenantId) || !routes.includes(payload.route)) throw new Error('CONSUMER_AUTHORIZATION_DENIED');
    if (payload.route === 'projection') return consumer.consume(payload);
    const tenant = payload.tenantId;
    const client = await pool.connect();
    let source;
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE kavaroutes_outbox_consumer');
      await client.query("SELECT set_config('app.tenant_id',$1,true)", [tenant]);
      if (payload.jobType === 'kr.realtime-signal.trip.v1' && payload.purposeReference === 'RIDER_INTAKE') {
        source = (await client.query(`SELECT t.service_date::text, 'trip'::text AS resource_kind FROM outbox.message m JOIN intake.trip_request t
          ON t.tenant_id=m.tenant_id AND t.id=m.aggregate_id WHERE m.tenant_id=$1 AND m.event_id=$2`, [tenant, payload.eventId])).rows[0];
      } else if (payload.jobType === 'kr.realtime-signal.driver-shift.v1' && payload.purposeReference === 'ASSIGNED_SERVICE_DELIVERY') {
        source = (await client.query(`SELECT r.service_date::text, 'driver-shift'::text AS resource_kind FROM outbox.message m
          JOIN execution.shift_policy_snapshot s ON s.tenant_id=m.tenant_id AND s.id=m.aggregate_id
          JOIN dispatch.assignment a ON a.tenant_id=s.tenant_id AND a.id=s.assignment_id
          JOIN dispatch.run r ON r.tenant_id=a.tenant_id AND r.id=a.run_id
          WHERE m.tenant_id=$1 AND m.event_id=$2`, [tenant, payload.eventId])).rows[0];
      } else if (payload.jobType === 'kr.realtime-signal.dispatch-assignment.v1' && payload.purposeReference === 'ASSIGNED_SERVICE_DELIVERY' && payload.aggregateType === 'ASSIGNMENT' && payload.eventType === 'DispatchAssignmentCommitted') {
        source = (await client.query(`SELECT r.service_date::text, 'run'::text AS resource_kind,
          r.id::text AS resource_id,(m.payload->>'runVersion')::bigint AS resource_version FROM outbox.message m
          JOIN dispatch.assignment a ON a.tenant_id=m.tenant_id AND a.id=m.aggregate_id
          JOIN dispatch.run r ON r.tenant_id=a.tenant_id AND r.id=a.run_id
          WHERE m.tenant_id=$1 AND m.event_id=$2 AND m.payload->>'runId'=r.id::text`, [tenant, payload.eventId])).rows[0];
      } else if(payload.jobType==='kr.realtime-signal.route-proposal.v1' && payload.purposeReference==='ASSIGNED_SERVICE_DELIVERY' && payload.aggregateType==='ROUTE_PROPOSAL' && payload.eventType==='RouteProposalRecorded') {
        source=(await client.query(`SELECT r.service_date::text,'operation'::text AS resource_kind FROM outbox.message m
          JOIN dispatch.route_proposal p ON p.tenant_id=m.tenant_id AND p.id=m.aggregate_id
          JOIN dispatch.run r ON r.tenant_id=p.tenant_id AND r.id=p.run_id
          WHERE m.tenant_id=$1 AND m.event_id=$2 AND m.payload->>'runId'=r.id::text`,[tenant, payload.eventId])).rows[0];
      } else throw new Error('CONSUMER_AUTHORIZATION_DENIED');
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    if (!source) throw new Error('MESSAGE_REFERENCE_NOT_FOUND');
    return realtime.consume(payload, { purpose: 'DISPATCH_CONTROL', scope: { streamKind: 'DISPATCH_DAY',
      scopeReference: branchScopeReference, serviceDate: source.service_date },
      delta: { kind: 'RESOURCE_INVALIDATED', resourceKind: source.resource_kind, resourceReference: `${source.resource_kind}:${source.resource_id ?? payload.aggregateId}`, resourceVersion: Number(source.resource_version ?? payload.aggregateVersion) } });
  }

  async function cycle() {
    lastSuccess = 0;
    await verifyRuntimeDatabase(pool, 'worker');
    // Bounded, operator-enrolled tenant set. An empty registry fails loudly so a
    // misconfigured deployment cannot look healthy while doing no work.
    const activeTenants = await tenants.enrolled(enrollmentBound);
    if (activeTenants.length === 0) throw new Error('WORKER_ENROLLMENT_EMPTY');
    enrolled = new Set(activeTenants);
    if(Date.now()-lastTrackingEvaluation>=5000){
      for(const tenant of activeTenants) await reconcileTrackingAlerts(pool,tenant);
      lastTrackingEvaluation=Date.now();
    }
    let unresolvedFailure = false;
    for (const route of routes) {
      const queue = ROUTE_POLICIES[route].queue;
      for (const tenantId of activeTenants) {
        const controlClient = await pool.connect();
        let paused;
        try {
          await controlClient.query('BEGIN');
          await controlClient.query('SET LOCAL ROLE kavaroutes_outbox_consumer');
          await controlClient.query("SELECT set_config('app.tenant_id',$1,true)", [tenantId]);
          const control = (await controlClient.query('SELECT paused,kill_switch FROM outbox.route_control WHERE tenant_id=$1 AND route=$2', [tenantId, route])).rows[0];
          paused = control?.paused || control?.kill_switch;
          await controlClient.query('COMMIT');
        } catch (error) { await controlClient.query('ROLLBACK'); throw error; } finally { controlClient.release(); }
        if (paused) continue;
        const leases = await outbox.claimEligible({ tenantId, publisherId, route, limit: 8, leaseMilliseconds: 30000 });
        for (const lease of leases) {
          try { await outbox.publishLeased({ ...lease, publisherId }, transport); }
          catch (error) { await outbox.failLeased({ ...lease, publisherId, failureClass: classifyFailure(error) }); }
        }
      }
      // Explicit supervision expires abandoned active jobs after a worker crash.
      await boss.supervise(queue);
      const reconciled = await recovery.reconcile(queue, activeTenants);
      unresolvedFailure ||= reconciled.unresolved;
      // One job at a time avoids expiring a fetched batch while earlier jobs run.
      const jobs = await boss.fetch(queue, { batchSize: 1 });
      for (const job of jobs) {
        try { await consume(job.data); await boss.complete(queue, job.id); }
        catch (error) { await boss.fail(queue, job.id, { code: classifyFailure(error) }); unresolvedFailure = true; }
      }
    }
    await pool.query('SELECT 1');
    if (!unresolvedFailure) lastSuccess = Date.now();
  }
  function runOnce() {
    if (stopped) throw new Error('WORKER_STOPPED');
    if (!inFlight) inFlight = cycle().finally(() => { inFlight = undefined; });
    return inFlight;
  }
  const tick = async () => {
    try { await runOnce(); } catch { lastSuccess = 0; }
    if (!stopped) timer = setTimeout(() => void tick(), 1000);
  };
  return { pool, boss, consume, runOnce, start() { void tick(); },
    healthy() { return !stopped && lastSuccess > 0 && Date.now() - lastSuccess < 15000; },
    async close() { stopped = true; clearTimeout(timer); await inFlight?.catch(() => {}); await boss.stop(); await pool.end(); } };
}
