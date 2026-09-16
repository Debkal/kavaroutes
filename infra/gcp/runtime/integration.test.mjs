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

// Explicit opt-in: creates and removes only this randomly named, disposable local container.
test('private PostgreSQL API/outbox/worker integration', { skip: process.env.KR_CLOUD_LOCAL_TEST !== '1', timeout: 120000 }, async () => {
  const name = `kr-cloud-test-${randomUUID().slice(0, 8)}`;
  const adminPassword = randomBytes(32).toString('base64url');
  const passwords = { kr_cloud_api: randomBytes(32).toString('base64url'), kr_cloud_worker: randomBytes(32).toString('base64url') };
  const docker = args => {
    try { return execFileSync('docker', args, { encoding: 'utf8', timeout: 30000, killSignal: 'SIGKILL', maxBuffer: 2 * 1024 * 1024,
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
    await checkIdentityMembership(control);
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
    assert.equal(worker.healthy(), false, 'terminal jobs must keep readiness degraded');
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
    const authorized = input => input.actorReference === 'synthetic.operator';
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
    await assert.rejects(() => worker.pool.query("UPDATE outbox.consumer_transport_journal SET actor_reference='synthetic.changed'"), /permission denied/);
    await assert.rejects(() => control.query("UPDATE outbox.consumer_transport_journal SET actor_reference='synthetic.changed'"), /IMMUTABLE/);
    assert.equal((await worker.pool.query('SELECT count(*)::int AS n FROM outbox.consumer_transport_journal')).rows[0].n, 0, 'unscoped runtime read must be empty');
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
    docker(['rm', '--force', '--volumes', name]);
  }
});
