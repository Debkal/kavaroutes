import test from 'node:test';
import assert from 'node:assert/strict';
import { checkIdentityMembership } from './identity-membership-check.mjs';
import { randomBytes, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {readFileSync} from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool } from 'pg';
import WebSocket from 'ws';
import { initializeDatabase } from './database.mjs';
import { createRuntimeApi } from './api.mjs';
import { createRuntimeWorker } from './worker.mjs';
import { createRecovery } from './recovery.mjs';
import { checkProcesses } from './process-check.mjs';
import { checkDatabaseGuards } from './database-check.mjs';
import { checkLiveNetwork } from './network-check.mjs';
import { checkContainers } from './container-check.mjs';
import { tenantId, riderId, schema, branchScopeReference } from './config.mjs';
import {verifyRouteProposals} from '../../../packages/api-contracts/test/helpers/route-proposals.mjs';
import {verifyDriverPostcheck} from '../../../packages/api-contracts/test/helpers/driver-postcheck.mjs';
import {verifyDriverClosure} from '../../../packages/api-contracts/test/helpers/driver-closure.mjs';
import {verifyFacilityDay} from '../../../packages/api-contracts/test/helpers/facility-day.mjs';
import {verifyBrowserCommandRecovery} from '../../../packages/api-contracts/test/helpers/browser-command-recovery.mjs';
import {verifyBrowserRecoveryApi,verifyRecoveryCommand} from '../../../packages/api-contracts/test/helpers/browser-recovery-api.mjs';
import {withTenantTransaction} from '@kavaroutes/postgres-persistence';
import {authorizeRealtimeSubscription,createTestOnlyCursorCodec} from '@kavaroutes/realtime';
import {createPostgresRealtimeStore} from '@kavaroutes/realtime/postgres';
import {companyBranchScope} from '@kavaroutes/api-contracts/security';
import {createWp007PostgresApplication} from '@kavaroutes/api-contracts';
import {validateEventEnvelope,validateThinJobPayload} from '@kavaroutes/durable-execution';

// Explicit opt-in: creates and removes only this randomly named, disposable local container.
test('private PostgreSQL API/outbox/worker integration', { skip: process.env.KR_CLOUD_LOCAL_TEST !== '1', timeout: 120000 }, async () => {
  const name = `kr-cloud-test-${randomUUID().slice(0, 8)}`;
  const adminPassword = randomBytes(32).toString('base64url');
  const passwords = { kr_cloud_api: randomBytes(32).toString('base64url'), kr_cloud_worker: randomBytes(32).toString('base64url') };
  const docker = args => {
    // A busy host can take longer than 30 s to start or remove the disposable PostGIS
    // container; 90 s keeps a slow daemon from failing an otherwise green suite.
    try { return execFileSync('docker', args, { encoding: 'utf8', timeout: 90000, killSignal: 'SIGKILL', maxBuffer: 2 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, POSTGRES_PASSWORD: adminPassword } }); }
    catch (error) { throw new Error(error.code === 'ETIMEDOUT' ? 'DOCKER_COMMAND_TIMEOUT' : `DOCKER_COMMAND_FAILED_${args[0].toUpperCase()}`); }
  };
  let control, api, worker;
  try {
    docker(['run', '--detach', '--name', name, '--label', 'kavaroutes.scope=cld006-disposable', '--publish', '127.0.0.1::5432',
      '--env', 'POSTGRES_PASSWORD', '--env', 'POSTGRES_USER=kr_cloud_admin', '--env', 'POSTGRES_DB=kavaroutes_cloud',
      'postgis/postgis:17-3.5@sha256:624f5195b91d424dbebf018890148cc0e5a3e80db5467da8b53cc2ed2ce49216',
      '-c', 'shared_preload_libraries=pg_stat_statements']);
    const port = docker(['port', name, '5432/tcp']).trim().split(':').at(-1);
    const base = { profile: 'private-synthetic', port: 58080,
      etagSecret: `synthetic-etag-secret-${randomBytes(32).toString('base64url')}`, cursorSecret: randomBytes(32).toString('base64url') };
    const cfg = (role, password) => ({ ...base, databaseUrl: `postgresql://kr_cloud_${role}:${password}@127.0.0.1:${port}/kavaroutes_cloud` });
    const admin = cfg('admin', adminPassword);
    control = new Pool({ connectionString: admin.databaseUrl, connectionTimeoutMillis: 1000 });
    control.on('error', () => {}); // Expected while deliberately stopping the disposable DB.
    let ready = false;
    for (let i = 0; i < 60; i++) { try { await control.query('SELECT 1'); ready = true; break; } catch { await delay(500); } }
    assert.equal(ready, true, 'PostgreSQL must start');
    await initializeDatabase(admin, passwords);
    await initializeDatabase(admin, passwords); // Restart-safe migration and seed.
    await checkIdentityMembership(control, cfg('api', passwords.kr_cloud_api).databaseUrl);
    await checkDatabaseGuards(admin, passwords, cfg, control);
    await checkProcesses(role => cfg(role, passwords[`kr_cloud_${role}`]));
    api = await createRuntimeApi(cfg('api', passwords.kr_cloud_api));
    worker = await createRuntimeWorker(cfg('worker', passwords.kr_cloud_worker));
    assert.equal(worker.healthy(), false);
    const auth = { authorization: 'Synthetic principal_dispatcher' };
    const tripId = randomUUID();
    const body = { tripId, riderId, serviceDate: '2026-09-11', serviceTimezone: 'America/Los_Angeles', localServiceTime: '08:00:00',
      resolvedServiceAt: '2026-09-11T15:00:00.000Z', resolvedUtcOffsetSeconds: -25200, ambiguityPolicy: 'reject' };
    const request = { method: 'POST', url: `/v1/organizations/${tenantId}/trips`, headers: { ...auth, 'idempotency-key': 'cloud-synthetic-create-0001' }, payload: body };
    const created = await api.app.inject(request);
    assert.equal(created.statusCode, 201, created.body);
    assert.equal((await api.app.inject(request)).statusCode, 201);
    await worker.runOnce();
    assert.equal(worker.healthy(), true);
    assert.equal((await control.query('SELECT count(*)::int AS n FROM outbox.consumer_inbox')).rows[0].n, 1);
    assert.equal((await control.query('SELECT count(*)::int AS n FROM realtime.change')).rows[0].n, 1);
    const denied = await api.app.inject({ method: 'GET', url: `/v1/organizations/22222222-2222-4222-8222-222222222222/trips/${tripId}`, headers: auth });
    assert.equal(denied.statusCode, 404);
    await assert.rejects(() => api.pool.query('SELECT * FROM intake.rider'), /permission denied/);
    await assert.rejects(() => worker.pool.query('SELECT * FROM intake.rider'), /permission denied/);
    const flags = await control.query("SELECT rolsuper,rolbypassrls,rolcreatedb,rolcreaterole FROM pg_roles WHERE rolname IN ('kr_cloud_api','kr_cloud_worker')");
    assert.equal(flags.rows.every(row => Object.values(row).every(v => v === false)), true);
    await worker.close();
    worker = await createRuntimeWorker(cfg('worker', passwords.kr_cloud_worker));
    await worker.runOnce();
    assert.equal((await control.query('SELECT count(*)::int AS n FROM outbox.consumer_inbox')).rows[0].n, 1);
    const jobs = await control.query(`SELECT data FROM ${schema}.job WHERE name='kr.projection.v1'`);
    assert.equal(await worker.consume(jobs.rows[0].data), 'DUPLICATE');
    assert.equal((await api.app.inject({ method: 'GET', url: '/health/ready' })).statusCode, 200);
    assert.equal((await api.app.inject({ method: 'GET', url: `/v1/organizations/${tenantId}/drivers`, headers: auth })).statusCode, 503);
    assert.equal((await api.app.inject({ method: 'GET', url: `/v1/organizations/${tenantId}/dispatch-days/2026-09-11`, headers: auth })).statusCode, 503);
    const snapshot = await api.app.inject({ method: 'GET', url: `/v1/organizations/${tenantId}/runtime-dispatch-snapshot?serviceDate=2026-09-11`, headers: auth });
    assert.equal(snapshot.statusCode, 200, snapshot.body);
    assert.equal(Object.keys(snapshot.json().projection).length, 1);
    const cancelled = await api.app.inject({ method: 'POST', url: `/v1/organizations/${tenantId}/trips/${tripId}/commands/cancel`,
      headers: { ...auth, 'idempotency-key': 'cloud-synthetic-cancel-0001', 'if-match': created.headers.etag }, payload: { reasonCode: 'SYNTHETIC_REQUESTER_CANCELLED' } });
    assert.equal(cancelled.statusCode, 200, cancelled.body);
    await worker.runOnce();
    await api.close();
    api = await createRuntimeApi(cfg('api', passwords.kr_cloud_api));
    const replay = await api.app.inject({ method: 'POST', url: `/v1/organizations/${tenantId}/realtime-change-queries`, headers: auth,
      payload: { purpose: 'DISPATCH_CONTROL', scope: { streamKind: 'DISPATCH_DAY', scopeReference: branchScopeReference, serviceDate: '2026-09-11' }, cursor: snapshot.json().cursor, limit: 100 } });
    assert.equal(replay.statusCode, 200, replay.body);
    assert.equal(replay.json().changes.length, 1);
    assert.equal(replay.json().changes[0].delta.resourceVersion, 2);
    await api.app.listen({ host: '127.0.0.1', port: 0 });
    const socketPort = api.app.server.address().port;
    await new Promise((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${socketPort}/v1/realtime`, 'kavaroutes.realtime.v1', { headers: { ...auth, origin: 'http://kavaroutes.test' } });
      const deadline = setTimeout(() => { socket.terminate(); reject(new Error('SOCKET_TIMEOUT')); }, 5000);
      socket.once('error', reject);
      socket.once('message', data => {
        try { assert.equal(JSON.parse(data).type, 'connection.ready'); socket.close(); clearTimeout(deadline); resolve(); }
        catch (error) { socket.terminate(); clearTimeout(deadline); reject(error); }
      });
    });
    // Supervisor expiry + retry of an abandoned job survives host reconstruction.
    const abandoned = await worker.boss.send('kr.projection.v1', jobs.rows[0].data, { retryLimit: 0 });
    await worker.boss.fetch('kr.projection.v1');
    await control.query(`UPDATE ${schema}.job SET started_on=now()-interval '1 hour' WHERE id=$1`, [abandoned]);
    await worker.close();
    worker = await createRuntimeWorker(cfg('worker', passwords.kr_cloud_worker));
    for (let attempt = 0; attempt < 24; attempt++) {
      await worker.runOnce();
      if ((await control.query(`SELECT state FROM ${schema}.job WHERE id=$1`, [abandoned])).rows[0].state === 'completed') break;
      await delay(500);
    }
    assert.equal((await control.query(`SELECT state FROM ${schema}.job WHERE id=$1`, [abandoned])).rows[0].state, 'completed');
    assert.equal((await control.query("SELECT count(*)::int AS n FROM outbox.consumer_transport_journal WHERE transport_id=$1 AND action='RETRY'", [abandoned])).rows[0].n, 1);
    await checkLiveNetwork(role => cfg(role, passwords[`kr_cloud_${role}`]));
    if (process.env.KR_CLOUD_IMAGE) await checkContainers(docker, name, role => cfg(role, passwords[`kr_cloud_${role}`]), control);
    // More than one reconciliation page of terminal jobs must not starve a retry.
    const terminalIds = [];
    for (let i = 0; i < 51; i++) terminalIds.push(await worker.boss.send('kr.projection.v1', jobs.rows[0].data, { retryLimit: 0 }));
    const transientId = await worker.boss.send('kr.projection.v1', jobs.rows[0].data, { retryLimit: 0 });
    const fetched = await worker.boss.fetch('kr.projection.v1', { batchSize: 100 });
    for (const job of fetched) await worker.boss.fail('kr.projection.v1', job.id, { code: job.id === transientId ? 'TRANSIENT_DEPENDENCY' : 'PERMANENT_VALIDATION' });
    await control.query(`UPDATE ${schema}.job SET completed_on=now()-interval '10 seconds' WHERE state='failed'`);
    const recovery = createRecovery(worker.pool, worker.boss);
    assert.equal((await recovery.reconcile('kr.projection.v1', [tenantId])).processed, 50);
    assert.equal((await recovery.reconcile('kr.projection.v1', [tenantId])).processed, 2);
    assert.equal((await recovery.reconcile('kr.projection.v1', [tenantId])).processed, 0);
    assert.equal((await control.query("SELECT count(*)::int AS n FROM outbox.consumer_transport_journal WHERE action='DEAD_LETTER'")).rows[0].n, 51);
    await worker.runOnce();
    // Readiness is a function of the current unresolved predicate, not of a remembered
    // success: dead-lettered work is reported instead of holding the worker down, so a
    // poison job costs a replay, not an operator restart (audit WEB-A-019, WEB-A-032).
    assert.equal(worker.healthy(), true, 'dead-lettered work must not hold readiness down');
    assert.equal(worker.diagnostics().unresolvedWork, false);
    assert.equal(worker.diagnostics().lastCycleFailure, null);
    const terminalQueues = worker.diagnostics().terminalFailures;
    assert.equal(terminalQueues?.[0]?.queue, 'kr.projection.v1');
    assert.ok(terminalQueues[0].count >= 51, `the body must count every terminal job, saw ${terminalQueues[0].count}`);
    // A first observed event above version 1 is not a gap when no predecessor exists:
    // a run entered by dispatch publishes its trip's first message at the version the
    // plan produced, so the consumer must bootstrap rather than poison both queues
    // (audit WEB-A-031).
    const firstSightId = randomUUID();
    await control.query(`INSERT INTO outbox.message
      (tenant_id,id,event_id,aggregate_type,aggregate_id,aggregate_version,event_type,schema_version,occurred_at,command_id,
       idempotency_reference_hash,correlation_id,source,classification_reference,purpose_reference,policy_reference,payload,retain_until)
      SELECT tenant_id,$1,$2,aggregate_type,$3,2,event_type,schema_version,now(),command_id,idempotency_reference_hash,$4,
        source,classification_reference,purpose_reference,policy_reference,payload,now()+interval '30 days 5 minutes'
      FROM outbox.message WHERE tenant_id=$5 AND aggregate_id=$6 AND aggregate_version=2`,
    [randomUUID(), randomUUID(), firstSightId, randomUUID(), tenantId, tripId]);
    await control.query(`INSERT INTO outbox.delivery (tenant_id,id,message_id,route,job_type,retain_until)
      SELECT tenant_id,$1,id,'projection','kr.projection.trip.v1',now()+interval '30 days 5 minutes'
      FROM outbox.message WHERE tenant_id=$2 AND aggregate_id=$3 AND aggregate_version=2`, [randomUUID(), tenantId, firstSightId]);
    await worker.runOnce();
    await worker.runOnce();
    assert.equal((await control.query('SELECT count(*)::int AS n FROM outbox.consumer_inbox WHERE aggregate_id=$1', [firstSightId])).rows[0].n, 1,
      'a first-sight event must be applied');
    assert.equal((await control.query(`SELECT applied_version::int AS version FROM outbox.consumer_projection WHERE aggregate_id=$1`, [firstSightId])).rows[0].version, 2);
    assert.equal((await control.query(`SELECT count(*)::int AS n FROM ${schema}.job WHERE data::jsonb->>'aggregateId'=$1 AND state='failed'`, [firstSightId])).rows[0].n, 0);
    assert.equal(worker.healthy(), true, 'applying a first-sight event leaves the worker ready');
    // Worker tenant enrollment is explicit, bounded and enforced per job. The
    // runtime role can read the bound through the definer function and can never
    // enroll itself.
    await worker.runOnce();
    const enrolledTenants = async () => (await worker.pool.query('SELECT platform.enrolled_tenants(25) AS tenant_id')).rows.map(row => row.tenant_id);
    assert.deepEqual(await enrolledTenants(), [tenantId]);
    assert.equal((await worker.pool.query('SELECT platform.enrolled_tenants(1000) AS tenant_id')).rowCount, 0, 'the bound is enforced in SQL');
    await assert.rejects(() => worker.pool.query("INSERT INTO platform.worker_enrollment(tenant_id) VALUES('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')"), /permission denied/);
    const foreignPayload = { ...jobs.rows[0].data, tenantId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', route: 'realtime-signal',
      jobType: 'kr.realtime-signal.trip.v1', purposeReference: 'RIDER_INTAKE' };
    await assert.rejects(() => worker.consume(foreignPayload), /CONSUMER_AUTHORIZATION_DENIED/);
    await control.query("INSERT INTO platform.worker_enrollment(tenant_id) VALUES('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')");
    await worker.runOnce();
    assert.deepEqual((await enrolledTenants()).sort(), [tenantId, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'].sort(), 'enrollment is refreshed each cycle');
    await assert.rejects(() => worker.consume(foreignPayload), /MESSAGE_REFERENCE_NOT_FOUND/, 'an enrolled tenant is processed, not silently skipped');
    await control.query("DELETE FROM platform.worker_enrollment WHERE tenant_id='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'");
    await worker.runOnce();
    // pg-boss start_after/backoff uses database time. A single immediate cycle
    // need not make a freshly re-enrolled retry eligible, especially after image checks.
    for(let attempt=0;attempt<80;attempt++){
      if((await control.query(`SELECT state FROM ${schema}.job WHERE id=$1`,[transientId])).rows[0].state==='completed')break;
      await delay(250);await worker.runOnce();
    }
    assert.equal((await control.query(`SELECT state FROM ${schema}.job WHERE id=$1`, [transientId])).rows[0].state, 'completed');
    const replayRequest = { tenantId, queue: 'kr.projection.v1', jobId: terminalIds[0], requestId: randomUUID(),
      actorReference: 'synthetic.operator', reasonCode: 'OPERATOR_REVIEWED' };
    await assert.rejects(() => recovery.replay(replayRequest, [tenantId]), /REPLAY_AUTHORIZATION_DENIED/);
    await assert.rejects(() => recovery.replay(replayRequest), /RECOVERY_SCOPE_DENIED/, 'a replay without an explicit enrolled tenant set is refused');
    // Tenant-scoped on purpose: an actor name alone is not tenant authority.
    const authorized = input => input.tenantId === tenantId && input.actorReference === 'synthetic.operator';
    const brokenRecovery = createRecovery(worker.pool, { retry: async (...args) => { await worker.boss.retry(...args); throw new Error('TEST_AFTER_RETRY_BEFORE_COMMIT'); } }, authorized);
    await assert.rejects(() => brokenRecovery.replay(replayRequest, [tenantId]), /TEST_AFTER_RETRY_BEFORE_COMMIT/);
    assert.equal((await control.query(`SELECT state FROM ${schema}.job WHERE id=$1`, [replayRequest.jobId])).rows[0].state, 'failed');
    assert.equal((await control.query('SELECT count(*)::int AS n FROM outbox.consumer_transport_journal WHERE id=$1', [replayRequest.requestId])).rows[0].n, 0);
    const allowedRecovery = createRecovery(worker.pool, worker.boss, authorized);
    await control.query(`INSERT INTO outbox.route_control(tenant_id,route,paused,kill_switch,reason_code,actor_reference)
      VALUES ($1,'projection',true,false,'SYNTHETIC_PAUSE','synthetic.operator')`, [tenantId]);
    await assert.rejects(() => allowedRecovery.replay(replayRequest, [tenantId]), /REPLAY_ROUTE_STOPPED/);
    await control.query("UPDATE outbox.route_control SET paused=false,kill_switch=true WHERE tenant_id=$1 AND route='projection'", [tenantId]);
    await assert.rejects(() => allowedRecovery.replay(replayRequest, [tenantId]), /REPLAY_ROUTE_STOPPED/);
    assert.equal((await control.query('SELECT count(*)::int AS n FROM outbox.consumer_transport_journal WHERE id=$1', [replayRequest.requestId])).rows[0].n, 0);
    await control.query("UPDATE outbox.route_control SET kill_switch=false WHERE tenant_id=$1 AND route='projection'", [tenantId]);
    assert.equal(await allowedRecovery.replay(replayRequest, [tenantId]), 'ENROLLED');
    assert.equal(await allowedRecovery.replay(replayRequest, [tenantId]), 'REPLAYED');
    await assert.rejects(() => allowedRecovery.replay({ ...replayRequest, jobId: terminalIds[1] }, [tenantId]), /REPLAY_IDEMPOTENCY_MISMATCH/);
    await assert.rejects(() => allowedRecovery.replay({ ...replayRequest, tenantId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }, [tenantId]), /REPLAY_AUTHORIZATION_DENIED/);
    await worker.runOnce();
    assert.equal((await control.query(`SELECT state FROM ${schema}.job WHERE id=$1`, [replayRequest.jobId])).rows[0].state, 'completed');
    assert.equal((await control.query('SELECT status FROM outbox.delivery WHERE id=$1', [jobs.rows[0].data.deliveryId])).rows[0].status, 'PUBLISHED');
    // A published delivery whose transport job was deleted (incident recovery) has no
    // replay handle: the delivery is finished from the publisher's side and no job exists,
    // while the consumer never recorded the event. The operator backfill proves that, is
    // authorized and journalled like every replay, and re-queues the delivery so the
    // ordinary publisher re-creates the job (audit WEB-A-031).
    const lostAggregateId = randomUUID(), lostMessageId = randomUUID(), lostDeliveryId = randomUUID();
    await control.query(`INSERT INTO outbox.message
      (tenant_id,id,event_id,aggregate_type,aggregate_id,aggregate_version,event_type,schema_version,occurred_at,command_id,
       idempotency_reference_hash,correlation_id,source,classification_reference,purpose_reference,policy_reference,payload,retain_until)
      SELECT tenant_id,$1,$2,aggregate_type,$3,2,event_type,schema_version,now(),command_id,idempotency_reference_hash,$4,
        source,classification_reference,purpose_reference,policy_reference,payload,now()+interval '30 days 5 minutes'
      FROM outbox.message WHERE tenant_id=$5 AND aggregate_id=$6 AND aggregate_version=2`,
    [lostMessageId, randomUUID(), lostAggregateId, randomUUID(), tenantId, tripId]);
    await control.query(`INSERT INTO outbox.delivery
      (tenant_id,id,message_id,route,job_type,status,transport_reference,first_published_at,last_published_at,retain_until)
      SELECT tenant_id,$1,id,'projection','kr.projection.trip.v1','PUBLISHED','transport.synthetic.lost',now(),now(),
        now()+interval '30 days 5 minutes' FROM outbox.message WHERE tenant_id=$2 AND id=$3`,
    [lostDeliveryId, tenantId, lostMessageId]);
    assert.equal((await control.query(`SELECT count(*)::int AS n FROM ${schema}.job WHERE data::jsonb->>'deliveryId'=$1`, [lostDeliveryId])).rows[0].n, 0);
    assert.equal((await control.query('SELECT status FROM outbox.delivery WHERE id=$1', [lostDeliveryId])).rows[0].status, 'PUBLISHED',
      'the modelled post-incident delivery is published with no job');
    const backfillRequest = { tenantId, deliveryId: lostDeliveryId, requestId: randomUUID(),
      actorReference: 'synthetic.operator', reasonCode: 'OPERATOR_REVIEWED' };
    await assert.rejects(() => recovery.backfill(backfillRequest, [tenantId]), /BACKFILL_AUTHORIZATION_DENIED/);
    await assert.rejects(() => allowedRecovery.backfill(backfillRequest), /RECOVERY_SCOPE_DENIED/);
    await assert.rejects(() => allowedRecovery.backfill({ ...backfillRequest, deliveryId: randomUUID() }, [tenantId]), /BACKFILL_DELIVERY_NOT_FOUND/);
    await assert.rejects(() => allowedRecovery.backfill({ ...backfillRequest, tenantId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }, [tenantId]), /BACKFILL_AUTHORIZATION_DENIED/);
    assert.equal((await allowedRecovery.backfill(backfillRequest, [tenantId])).status, 'REQUEUED');
    // The same decision replayed is answered from the journal, not applied twice.
    assert.equal((await allowedRecovery.backfill(backfillRequest, [tenantId])).status, 'REPLAYED');
    assert.equal((await control.query('SELECT status FROM outbox.delivery WHERE id=$1', [lostDeliveryId])).rows[0].status, 'PENDING');
    assert.deepEqual((await control.query('SELECT action,safe_code FROM outbox.consumer_transport_journal WHERE id=$1', [backfillRequest.requestId])).rows[0],
      { action: 'REPLAY', safe_code: 'OPERATOR_REVIEWED' });
    await worker.runOnce();
    await worker.runOnce();
    assert.equal((await control.query(`SELECT count(*)::int AS n FROM outbox.consumer_inbox WHERE event_id=$1 AND processing_state='COMPLETED'`,
      [(await control.query('SELECT event_id FROM outbox.message WHERE id=$1', [lostMessageId])).rows[0].event_id])).rows[0].n, 1,
      'the re-queued delivery is applied by the ordinary cycle');
    assert.equal((await control.query(`SELECT applied_version::int AS version FROM outbox.consumer_projection WHERE aggregate_id=$1`, [lostAggregateId])).rows[0].version, 2);
    // An event the route's consumer already holds is reported, never re-queued.
    assert.equal((await allowedRecovery.backfill({ ...backfillRequest, requestId: randomUUID() }, [tenantId])).status, 'ALREADY_APPLIED');
    await assert.rejects(() => worker.pool.query("UPDATE outbox.consumer_transport_journal SET actor_reference='synthetic.changed'"), /permission denied/);
    await assert.rejects(() => control.query("UPDATE outbox.consumer_transport_journal SET actor_reference='synthetic.changed'"), /IMMUTABLE/);
    assert.equal((await worker.pool.query('SELECT count(*)::int AS n FROM outbox.consumer_transport_journal')).rows[0].n, 0, 'unscoped runtime read must be empty');
    // ---- Audit repairs A-001 and A-002 (audit of f079c78) -------------------
    // A second company whose trip, aggregate versions, outbox messages and
    // deliveries are written by the real domain service, so the multi-company
    // runtime consumes exactly what production writes (TripCreated/TripCancelled)
    // instead of authored event names, and every thin job payload is derived from
    // the stored row rather than restated here.
    const companyB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const bRiderId = randomUUID(), bTripId = randomUUID();
    await withTenantTransaction(control, companyB, 'kavaroutes_migration', async client => {
      await client.query("INSERT INTO platform.organization(tenant_id,id,synthetic_name) VALUES($1,$1,'Pony second company')", [companyB]);
      await client.query("INSERT INTO intake.rider(tenant_id,id,synthetic_reference) VALUES($1,$2,'Synthetic second-company rider')", [companyB, bRiderId]);
    });
    await control.query('INSERT INTO platform.worker_enrollment(tenant_id) VALUES($1) ON CONFLICT DO NOTHING', [companyB]);
    const bMutationPool = new Pool({ connectionString: cfg('api', passwords.kr_cloud_api).databaseUrl, connectionTimeoutMillis: 1000 });
    const bApplication = createWp007PostgresApplication(bMutationPool, { etagSecret: `synthetic-etag-secret-${randomBytes(24).toString('base64url')}` });
    const bMutationActor = Object.freeze({ id: 'synthetic.cloudbuilder-second-company' });
    const bCreated = await bApplication.createTrip({ organizationId: companyB, principal: bMutationActor, key: 'cloud-second-company-create-0001',
      request: { tripId: bTripId, riderId: bRiderId, serviceDate: '2026-09-11', serviceTimezone: 'America/Los_Angeles', localServiceTime: '08:00:00',
        resolvedServiceAt: '2026-09-11T15:00:00.000Z', resolvedUtcOffsetSeconds: -25200, ambiguityPolicy: 'reject' } });
    assert.equal(bCreated.statusCode, 201, 'the second company trip is created by the real domain service');
    const bSources = async () => (await control.query(`SELECT m.event_id,m.event_type,m.schema_version,m.aggregate_type,m.aggregate_id,m.aggregate_version,
        m.occurred_at,m.command_id,m.idempotency_reference_hash,m.correlation_id,m.source,m.classification_reference,m.purpose_reference,
        m.policy_reference,m.payload,d.id AS delivery_id,d.route,d.job_type FROM outbox.message m
        JOIN outbox.delivery d ON d.tenant_id=m.tenant_id AND d.message_id=m.id WHERE m.tenant_id=$1
        ORDER BY m.aggregate_version,d.route`, [companyB])).rows;
    const bSource = async (aggregateVersion, route) => (await bSources()).find(row => Number(row.aggregate_version) === aggregateVersion && row.route === route);
    const bThinJob = row => ({ tenantId: companyB, deliveryId: row.delivery_id, eventId: row.event_id, route: row.route, jobType: row.job_type,
      eventType: row.event_type, schemaVersion: row.schema_version, aggregateType: row.aggregate_type, aggregateId: row.aggregate_id,
      aggregateVersion: Number(row.aggregate_version), correlationId: row.correlation_id, classificationReference: row.classification_reference,
      purposeReference: row.purpose_reference, policyReference: row.policy_reference });
    const bEnvelope = row => ({ eventId: row.event_id, aggregateType: row.aggregate_type, aggregateId: row.aggregate_id,
      aggregateVersion: Number(row.aggregate_version), eventType: row.event_type, schemaVersion: row.schema_version,
      occurredAt: new Date(row.occurred_at).toISOString(), commandId: row.command_id, idempotencyReferenceHash: row.idempotency_reference_hash,
      correlationId: row.correlation_id, source: row.source, classificationReference: row.classification_reference,
      purposeReference: row.purpose_reference, policyReference: row.policy_reference, payload: row.payload });
    // A-005: the stored source envelope and the thin job payload built from it must
    // both pass the unchanged domain validators before the worker ever sees them.
    // An unsupported event name, an invented payload or a mismatched version fails
    // here instead of silently producing no invalidation.
    const bValidated = async row => {
      assert.deepEqual(validateEventEnvelope(bEnvelope(row)), bEnvelope(row), `${row.event_type} source envelope`);
      assert.deepEqual(validateThinJobPayload(bThinJob(row)), bThinJob(row), `${row.event_type} thin job payload`);
    };
    assert.equal((await bSources()).length, 2, 'the real create mutation writes one message and one delivery per route');
    for (const row of await bSources()) await bValidated(row);
    // The projection delivery is published by nobody: the reconciliation
    // regression sends its own job against this real outbox row.
    // A fixture write into outbox.delivery must satisfy the table's own invariants:
    // outbox.validate_delivery_transition() advances lifecycle_version by exactly one
    // per row update and only allows PENDING->LEASED and LEASED->PUBLISHED, and the
    // PUBLISHED check requires a transport reference. The two steps below therefore
    // mirror the real publish path in packages/durable-execution/src/store.ts (lease,
    // then publish) instead of forcing a state the schema does not permit. Each step
    // asserts its row count so a fixture that matches nothing cannot pass silently.
    const publishProjectionFixture = async () => {
      const leased = await control.query(`UPDATE outbox.delivery SET status='LEASED',lease_owner='synthetic.fixture',
        lease_expires_at=now()+interval '5 minutes',lifecycle_version=lifecycle_version+1
        WHERE tenant_id=$1 AND route='projection' AND status='PENDING'`, [companyB]);
      assert.equal(leased.rowCount, 1, 'the second company projection delivery is leased by the fixture');
      const published = await control.query(`UPDATE outbox.delivery SET status='PUBLISHED',lease_owner=NULL,lease_expires_at=NULL,
        transport_reference='synthetic.published',first_published_at=COALESCE(first_published_at,now()),last_published_at=now(),
        lifecycle_version=lifecycle_version+1 WHERE tenant_id=$1 AND route='projection' AND status='LEASED'`, [companyB]);
      assert.equal(published.rowCount, 1, 'the second company projection delivery is published by the fixture');
    };
    await publishProjectionFixture();
    await worker.runOnce();
    // A-002: the second company's own invalidation is published once, to its own
    // canonical branch scope, and never to the fixture company's scope.
    const bStream = await control.query(`SELECT c.resource_reference,c.resource_version,s.purpose,s.scope_kind,s.scope_hash
      FROM realtime.change c JOIN realtime.stream s ON s.tenant_id=c.tenant_id AND s.id=c.stream_id WHERE c.tenant_id=$1`, [companyB]);
    assert.equal(bStream.rowCount, 1, 'the second company receives exactly one invalidation for its own event');
    assert.equal(bStream.rows[0].purpose, 'DISPATCH_CONTROL');
    assert.equal(bStream.rows[0].scope_kind, 'DISPATCH_DAY');
    assert.equal(bStream.rows[0].resource_reference, `trip:${bTripId}`);
    // The fixture company legitimately owns more than one dispatch-day stream:
    // checkLiveNetwork() drives two real trips on 2026-09-12 through the same
    // disposable database, so the guarantee under test is not "exactly one stream
    // per company" but "the fixture trip lives in exactly one stream, and the
    // second company's stream is not any of the fixture company's streams".
    const aOwnStreams = await control.query(`SELECT DISTINCT encode(s.scope_hash,'hex') AS scope_hash
      FROM realtime.stream s JOIN realtime.change c ON c.tenant_id=s.tenant_id AND c.stream_id=s.id
      WHERE s.tenant_id=$1 AND s.purpose='DISPATCH_CONTROL' AND s.scope_kind='DISPATCH_DAY' AND c.resource_reference=$2`,
      [tenantId, `trip:${tripId}`]);
    assert.equal(aOwnStreams.rowCount, 1, `the fixture trip is invalidated in exactly one fixture-company dispatch stream: ${JSON.stringify(aOwnStreams.rows)}`);
    const aScopes = await control.query("SELECT DISTINCT encode(scope_hash,'hex') AS scope_hash FROM realtime.stream WHERE tenant_id=$1 AND purpose='DISPATCH_CONTROL' AND scope_kind='DISPATCH_DAY'", [tenantId]);
    assert.equal(aScopes.rows.some(row => row.scope_hash === Buffer.from(bStream.rows[0].scope_hash).toString('hex')), false,
      `the second company must not publish into any fixture company branch scope: ${JSON.stringify(aScopes.rows)}`);
    const readPool = new Pool({ connectionString: cfg('api', passwords.kr_cloud_api).databaseUrl, connectionTimeoutMillis: 1000 });
    const readStore = createPostgresRealtimeStore(readPool, createTestOnlyCursorCodec({ secret: randomBytes(32).toString('base64url') }));
    const bPrincipal = Object.freeze({ id: randomUUID(), kind: 'BROWSER_USER', organizationId: companyB, capabilities: new Set(['dispatch:read']),
      purposes: new Set(['ASSIGNED_SERVICE_DELIVERY']), branchScopes: new Set([companyBranchScope(companyB)]), fleetScopes: new Set() });
    const bAuthorization = authorizeRealtimeSubscription({ principal: bPrincipal, organizationId: companyB, authorizationGeneration: 1,
      purpose: 'DISPATCH_CONTROL', scope: { streamKind: 'DISPATCH_DAY', scopeReference: companyBranchScope(companyB), serviceDate: '2026-09-11' } });
    const bSnapshot = await readStore.snapshot(bAuthorization);
    assert.equal(Object.values(bSnapshot.projection).length, 1, 'the second company invalidation is recoverable through its authorized subscription');
    assert.equal(Object.values(bSnapshot.projection)[0].resourceVersion, 1);
    assert.throws(() => authorizeRealtimeSubscription({ principal: bPrincipal, organizationId: companyB, authorizationGeneration: 1,
      purpose: 'DISPATCH_CONTROL', scope: { streamKind: 'DISPATCH_DAY', scopeReference: companyBranchScope(tenantId), serviceDate: '2026-09-11' } }),
      /REALTIME_AUTHORIZATION_DENIED/, 'the second company cannot subscribe to the fixture company scope');
    const aPrincipal = Object.freeze({ id: randomUUID(), kind: 'BROWSER_USER', organizationId: tenantId, capabilities: new Set(['dispatch:read']),
      purposes: new Set(['ASSIGNED_SERVICE_DELIVERY']), branchScopes: new Set([companyBranchScope(tenantId)]), fleetScopes: new Set() });
    const aProjection = await readStore.snapshot(authorizeRealtimeSubscription({ principal: aPrincipal, organizationId: tenantId, authorizationGeneration: 1,
      purpose: 'DISPATCH_CONTROL', scope: { streamKind: 'DISPATCH_DAY', scopeReference: companyBranchScope(tenantId), serviceDate: '2026-09-11' } }));
    assert.equal(Object.values(aProjection.projection).some(delta => delta.resourceReference === `trip:${bTripId}`), false,
      'the fixture company never observes the second company invalidation');
    // Version two of the same aggregate, cancelled through the real domain service
    // only after the first event was observed, so each cycle has exactly one
    // eligible delivery: exactly one further change, and the earlier cursor
    // replays it without duplicating anything.
    const bCancelled = await bApplication.cancelTrip({ organizationId: companyB, principal: bMutationActor, tripId: bTripId,
      key: 'cloud-second-company-cancel-0001', ifMatch: bCreated.headers.etag, request: { tripId: bTripId } });
    assert.equal(bCancelled.statusCode, 200, 'the second company trip is cancelled by the real domain service');
    assert.equal(bCancelled.body.trip.version, 2, 'the second event carries aggregate version two');
    await publishProjectionFixture();
    const bCancelledRow = await bSource(2, 'realtime-signal');
    await bValidated(bCancelledRow);
    for (let attempt = 0; attempt < 10; attempt++) {
      if (Number((await control.query('SELECT count(*)::int AS n FROM realtime.change WHERE tenant_id=$1', [companyB])).rows[0].n) >= 2) break;
      await worker.runOnce();
      await delay(100);
    }
    const bReplay = await readStore.replay(bAuthorization, bSnapshot.cursor);
    assert.equal(bReplay.changes.length, 1, 'the authorized cursor recovers exactly one new change');
    assert.equal(bReplay.changes[0].delta.resourceVersion, 2);
    assert.equal(await worker.consume(bThinJob(bCancelledRow)), 'DUPLICATE', 'a replayed delivery does not duplicate the business effect');
    await worker.close();
    worker = await createRuntimeWorker(cfg('worker', passwords.kr_cloud_worker));
    await worker.runOnce();
    const bAfterRestart = await readStore.snapshot(bAuthorization);
    assert.equal(Object.values(bAfterRestart.projection)[0].resourceVersion, 2, 'the second company invalidation survives worker reconstruction');
    // ---- A-001: enrollment is not actor authorization ----------------------
    // Authorization for these regressions is tenant-scoped: enrollment alone is
    // never authority, and the default callback still denies everything.
    const recoveryForA = createRecovery(worker.pool, worker.boss, async input => input.tenantId === tenantId);
    const recoveryForB = createRecovery(worker.pool, worker.boss, async input => input.tenantId === companyB);
    const defaultDenyRecovery = createRecovery(worker.pool, worker.boss);
    const bJobId = await worker.boss.send('kr.projection.v1', bThinJob(await bSource(1, 'projection')), { retryLimit: 0 });
    await control.query(`UPDATE ${schema}.job SET state='failed', output=$2::jsonb, completed_on=now()-interval '10 seconds' WHERE id=$1`,
      [bJobId, JSON.stringify({ code: 'PERMANENT_VALIDATION' })]);
    assert.ok((await recoveryForB.reconcile('kr.projection.v1', [companyB])).processed >= 1, 'the second company job reconciles under its own authority');
    const bJobBefore = (await control.query(`SELECT state,retry_count,output FROM ${schema}.job WHERE id=$1`, [bJobId])).rows[0];
    assert.equal(bJobBefore.state, 'failed');
    const bJournalCount = async () => Number((await control.query('SELECT count(*)::int AS n FROM outbox.consumer_transport_journal WHERE tenant_id=$1 AND transport_id=$2',
      [companyB, bJobId])).rows[0].n);
    assert.equal(await bJournalCount(), 1, 'the second company job has its own dead-letter journal entry');
    await assert.rejects(() => defaultDenyRecovery.replay({ ...replayRequest, jobId: bJobId }, [tenantId, companyB]), /REPLAY_AUTHORIZATION_DENIED/,
      'the default callback denies every replay before any tenant lookup');
    await assert.rejects(() => recoveryForA.replay({ ...replayRequest, jobId: bJobId }, [tenantId, companyB]), /REPLAY_NOT_FOUND/,
      'authority for the fixture company cannot replay the second company job');
    await assert.rejects(() => recoveryForB.replay({ ...replayRequest, tenantId: companyB, jobId: replayRequest.jobId }, [tenantId, companyB]), /REPLAY_NOT_FOUND/,
      'authority for the second company cannot replay the fixture company job or reuse its receipt');
    await assert.rejects(() => recoveryForB.replay({ ...replayRequest, jobId: bJobId, tenantId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' }, [tenantId, companyB]),
      /REPLAY_AUTHORIZATION_DENIED/, 'an unenrolled company is still refused');
    assert.deepEqual((await control.query(`SELECT state,retry_count,output FROM ${schema}.job WHERE id=$1`, [bJobId])).rows[0], bJobBefore,
      'a rejected cross-company replay changes nothing about the job');
    assert.equal(await bJournalCount(), 1, 'a rejected cross-company replay writes no journal row');
    assert.equal(Number((await control.query('SELECT count(*)::int AS n FROM outbox.consumer_transport_journal WHERE tenant_id=$1 AND id=$2',
      [companyB, replayRequest.requestId])).rows[0].n), 0, 'a rejected cross-company replay writes no receipt');
    assert.equal((await control.query(`SELECT state FROM ${schema}.job WHERE id=$1`, [replayRequest.jobId])).rows[0].state, 'completed',
      'the fixture company job is untouched by the swapped attempt');
    // The same job is replayable by the company that owns it, through the real
    // pg-boss transport inside the recovery transaction, and the enrolled retry is
    // then executed by the worker rather than only asserted.
    const bOwnerRequest = { tenantId: companyB, queue: 'kr.projection.v1', jobId: bJobId, requestId: randomUUID(),
      actorReference: 'synthetic.cloudbuilder-second-company', reasonCode: 'OPERATOR_REVIEWED' };
    assert.equal(await recoveryForB.replay(bOwnerRequest, [companyB]), 'ENROLLED', 'the owning company enrolls exactly one retry');
    assert.equal((await control.query('SELECT action,actor_reference FROM outbox.consumer_transport_journal WHERE tenant_id=$1 AND id=$2',
      [companyB, bOwnerRequest.requestId])).rows[0].action, 'REPLAY');
    assert.equal(await recoveryForB.replay(bOwnerRequest, [companyB]), 'REPLAYED', 'the same request replays idempotently');
    for (let attempt = 0; attempt < 20; attempt++) {
      if ((await control.query(`SELECT state FROM ${schema}.job WHERE id=$1`, [bJobId])).rows[0].state === 'completed') break;
      await worker.runOnce();
      await delay(100);
    }
    assert.equal((await control.query(`SELECT state FROM ${schema}.job WHERE id=$1`, [bJobId])).rows[0].state, 'completed',
      'the enrolled retry runs through the real transport and completes');
    assert.equal((await control.query("SELECT safe_state FROM outbox.consumer_projection WHERE tenant_id=$1 AND consumer_name='projection.trip' AND aggregate_id=$2",
      [companyB, bTripId])).rows[0].safe_state, 'DRAFT', 'the replayed projection applied the second company event exactly once');
    await control.query('DELETE FROM platform.worker_enrollment WHERE tenant_id=$1', [companyB]);
    await worker.runOnce();
    await bMutationPool.end();
    await readPool.end();
    // SOL-005: use an existing explicit synthetic fixture in this disposable database.
    await control.query(readFileSync(new URL('./seed-sol004-prototype.sql',import.meta.url),'utf8').replace(/^\\set ON_ERROR_STOP on\n/,''));
    const runId='32000000-0000-4000-8000-000000000007';
    const vehicleId='32000000-0000-4000-8000-000000000006';
    await control.query("INSERT INTO dispatch.run_service_requirements VALUES($1,$2,1,1,0,ARRAY[]::text[],ARRAY[]::text[])",[tenantId,runId]);
    await control.query('INSERT INTO fleet.vehicle_capacity VALUES($1,$2,4,0)',[tenantId,vehicleId]);
    const board=await api.app.inject({url:`/v1/organizations/${tenantId}/dispatch-board/2026-09-14`,headers:auth});
    assert.equal(board.statusCode,200,board.body);
    const run=board.json().runs.find(r=>r.runId===runId);
    const assignmentRecoveryId=randomUUID();
    const assignRequest={method:'POST',url:`/v1/organizations/${tenantId}/dispatch/runs/${runId}/commands/assign`,headers:{...auth,'if-match':run.expectedTag,'idempotency-key':`browser-command-${assignmentRecoveryId}`},payload:{driverId:'30000000-0000-4000-8000-000000000001',vehicleId,expectedVersion:run.version}};
    const recoveredAssignment=await verifyRecoveryCommand(api.app,tenantId,assignmentRecoveryId,{kind:'ASSIGN_RUN',resourceId:runId,expectedTag:run.expectedTag,body:assignRequest.payload});
    const assigned=await api.app.inject(assignRequest);
    assert.equal(assigned.statusCode,200,assigned.body);
    assert.deepEqual(assigned.json(),recoveredAssignment);
    assert.equal((await api.app.inject(assignRequest)).headers['kavaroutes-idempotency-replayed'],'true');
    await worker.runOnce();
    const updated=await api.app.inject({url:`/v1/organizations/${tenantId}/runtime-dispatch-snapshot?serviceDate=2026-09-14`,headers:auth});
    assert.equal(updated.statusCode,200,updated.body);
    assert.ok(Object.values(updated.json().projection).some(delta=>delta.resourceKind==='run' && delta.resourceReference===`run:${runId}` && delta.resourceVersion===assigned.json().version));
    const manifest=await api.app.inject({url:`/v1/organizations/${tenantId}/driver/itineraries/2026-09-14`,headers:{authorization:'Synthetic principal_driver'}});
    assert.equal(manifest.statusCode,200,manifest.body);
    assert.equal(manifest.json().legs.length,1);
    assert.equal(manifest.json().legs[0].assignmentId,assigned.json().assignmentId);
    await verifyRouteProposals(control,tenantId,{runId,legId:manifest.json().legs[0].tripLegId,vehicleId},async(decision,shiftId)=>{
      const read=await api.app.inject({url:`/v1/organizations/${tenantId}/dispatch/shifts/${shiftId}/route-proposals`,headers:auth});assert.equal(read.statusCode,200,read.body);
      const proposal=read.json().proposals.find(p=>p.proposalId===decision.proposalId);assert.ok(proposal);
      const result=await verifyRecoveryCommand(api.app,tenantId,decision.key.slice('browser-command-'.length),{kind:'DECIDE_ROUTE',resourceId:decision.proposalId,expectedTag:proposal.expectedTag,body:decision.request});assert.equal(result.state,'APPROVED');
    });
    const routeShift=(await control.query("SELECT id FROM execution.shift_policy_snapshot WHERE tenant_id=$1 AND assignment_id=$2 AND lifecycle='ACTIVE'",[tenantId,assigned.json().assignmentId])).rows[0].id;
    const routeUrl=`/v1/organizations/${tenantId}/driver/shifts/${routeShift}/route-proposals`;
    const routeRead=await api.app.inject({url:routeUrl,headers:{authorization:'Synthetic principal_driver'}});
    assert.equal(routeRead.statusCode,200,routeRead.body);
    const routeView=routeRead.json(),proposalId=randomUUID();
    const proposed=await api.app.inject({method:'POST',url:routeUrl,headers:{authorization:'Synthetic principal_driver','if-match':routeView.expectedTag,'idempotency-key':'runtime-route-proposal-0001'},payload:{proposalId,shiftGeneration:routeView.shiftGeneration,policyDigest:routeView.policyDigest,expectedRunVersion:routeView.runVersion,nodeOrder:routeView.nodes.map(n=>n.nodeId),parkedAttestation:true}});
    assert.equal(proposed.statusCode,200,proposed.body);assert.equal(proposed.json().state,'PENDING_DISPATCH_APPROVAL');
    const review=await api.app.inject({url:`/v1/organizations/${tenantId}/dispatch/shifts/${routeShift}/route-proposals`,headers:auth});
    assert.equal(review.statusCode,200,review.body);
    const proposedView=review.json().proposals.find(p=>p.proposalId===proposalId);
    const decisionRequest={method:'POST',url:`/v1/organizations/${tenantId}/dispatch/route-proposals/${proposalId}/commands/decide`,headers:{...auth,'if-match':proposedView.expectedTag,'idempotency-key':'runtime-route-decision-0001'},payload:{decision:'APPROVED',expectedRunVersion:review.json().runVersion}};
    const decided=await api.app.inject(decisionRequest);assert.equal(decided.statusCode,200,decided.body);assert.equal(decided.json().state,'APPROVED');
    assert.deepEqual((await api.app.inject(decisionRequest)).json(),decided.json());
    let routeRecovered=false;
    for(let attempt=0;attempt<80;attempt++){
      await worker.runOnce();
      const routeSnapshot=await api.app.inject({url:`/v1/organizations/${tenantId}/runtime-dispatch-snapshot?serviceDate=2026-09-14`,headers:auth});
      assert.equal(routeSnapshot.statusCode,200,routeSnapshot.body);
      routeRecovered=Object.values(routeSnapshot.json().projection).some(d=>d.resourceReference===`operation:${proposalId}`&&d.resourceVersion===2);
      if(routeRecovered)break;await delay(250);
    }
    assert.ok(routeRecovered,'persisted route decision reaches dispatcher recovery within bounded retry window');
    const finishedFixture=await verifyDriverPostcheck(control,tenantId,runId);
    await verifyDriverClosure(control,tenantId,finishedFixture,api.app);
    for(let attempt=0;attempt<12;attempt++)await worker.runOnce();
    const endedStatus=await api.app.inject({url:`/v1/organizations/${tenantId}/dispatch/shifts/${finishedFixture.shiftId}/status`,headers:auth});
    assert.equal(endedStatus.statusCode,200,endedStatus.body);assert.equal(endedStatus.json().tracking.status,'SHIFT_ENDED');
    await verifyFacilityDay(control,tenantId,manifest.json().legs[0].tripId,api.app);
    await verifyBrowserCommandRecovery(control,tenantId);
    await verifyBrowserRecoveryApi(control,tenantId,api.app);
    docker(['stop', '--time', '2', name]);
    assert.equal((await api.app.inject({ method: 'GET', url: '/health/ready' })).statusCode, 503);
    await assert.rejects(() => worker.runOnce());
    assert.equal(worker.healthy(), false);
  } finally {
    await worker?.close(); await api?.close(); await control?.end();
    // A busy docker daemon can exceed the helper's 30 s command timeout on removal; the
    // container is disposable either way, so one retry is enough to keep the suite green.
    try { docker(['rm', '--force', '--volumes', name]); }
    catch { try { docker(['rm', '--force', '--volumes', name]); } catch { /* left for the operator */ } }
  }
});
