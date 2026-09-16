import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool } from 'pg';
import { applyMigrations } from '../../postgres-persistence/scripts/migration-lib.mjs';
import { verifyDriverServiceProof } from './helpers/driver-service-proof.mjs';
import { verifyDispatchAuthority } from './helpers/dispatch-authority.mjs';
import {verifyRouteProposals} from './helpers/route-proposals.mjs';
import {verifyDriverPostcheck} from './helpers/driver-postcheck.mjs';
import {verifyDriverClosure} from './helpers/driver-closure.mjs';
import { createPostgresDriverSignatureService } from '../dist/index.js';
import { createDriverItineraryReader, createPostgresPersistence, withTenantTransaction } from '../../postgres-persistence/dist/index.js';
import { createPostgresDriverShiftService, createPostgresDriverActionService, createPostgresDriverPrecheckService, createPostgresDriverShiftStateReader, precheckItems, createWp007PostgresApplication, createWp007Api, syntheticIds } from '../dist/index.js';

test('persisted driver day enforces tenant, subject, date and cancellation boundaries', { skip: process.env.KR_DRIVER_LOCAL_TEST !== '1', timeout: 90000 }, async () => {
  const name = `kr-driver-itinerary-${randomUUID().slice(0, 8)}`;
  const password = randomBytes(32).toString('base64url');
  const docker = args => {
    try { return execFileSync('docker', args, { encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, POSTGRES_PASSWORD: password } }); }
    catch { throw new Error('DRIVER_TEST_CONTAINER_OPERATION_FAILED'); }
  };
  let pool, app;
  try {
    docker(['run', '--detach', '--name', name, '--publish', '127.0.0.1::5432', '--env', 'POSTGRES_PASSWORD', '--env', 'POSTGRES_DB=kavaroutes_driver_test',
      'postgis/postgis:17-3.5@sha256:624f5195b91d424dbebf018890148cc0e5a3e80db5467da8b53cc2ed2ce49216', '-c', 'shared_preload_libraries=pg_stat_statements']);
    const port = docker(['port', name, '5432/tcp']).trim().split(':').at(-1);
    pool = new Pool({ host: '127.0.0.1', port: Number(port), user: 'postgres', password, database: 'kavaroutes_driver_test', connectionTimeoutMillis: 1000 });
    pool.on('error', () => {});
    let ready = false;
    for (let attempt = 0; attempt < 60; attempt++) { try { await pool.query('SELECT 1'); ready = true; break; } catch { await delay(500); } }
    assert.equal(ready, true);
    const client = await pool.connect();
    try { await applyMigrations(client); } finally { client.release(); }
    const driverId = syntheticIds.driverSubject;
    const otherDriver = randomUUID();
    const tripId = randomUUID(); const legId = randomUUID(); const runId = randomUUID(); const assignmentId = randomUUID();
    const tenantId = syntheticIds.organizationA;
    await withTenantTransaction(pool, tenantId, 'kavaroutes_api', async db => {
      const branch = randomUUID(), rider = randomUUID(), origin = randomUUID(), destination = randomUUID(), vehicle = randomUUID();
      await db.query("INSERT INTO platform.organization(tenant_id,id,synthetic_name) VALUES ($1,$1,'Synthetic driver test')", [tenantId]);
      await db.query("INSERT INTO platform.branch(tenant_id,id,organization_id,synthetic_label) VALUES ($1,$2,$1,'Synthetic branch')", [tenantId, branch]);
      await db.query("INSERT INTO fleet.driver(tenant_id,id,synthetic_reference) VALUES ($1,$2,'Synthetic driver'),($1,$3,'Other synthetic driver')", [tenantId, driverId, otherDriver]);
      await db.query("INSERT INTO fleet.vehicle(tenant_id,id,synthetic_reference) VALUES ($1,$2,'Synthetic vehicle')", [tenantId, vehicle]);
      await db.query("INSERT INTO intake.address(tenant_id,id,customer_label) VALUES ($1,$2,'Synthetic pickup'),($1,$3,'Synthetic dropoff')", [tenantId, origin, destination]);
      await db.query("INSERT INTO intake.rider(tenant_id,id,synthetic_reference) VALUES ($1,$2,'Synthetic rider')", [tenantId, rider]);
      await db.query(`INSERT INTO intake.trip_request(tenant_id,id,rider_id,service_date,service_timezone,local_service_time,resolved_service_at,resolved_utc_offset_seconds,ambiguity_policy,ambiguity_policy_version,lifecycle_reference)
        VALUES ($1,$2,$3,'2026-09-13','America/Los_Angeles','09:00','2026-09-13T16:00:00Z',-25200,'reject','civil-v1','draft')`, [tenantId, tripId, rider]);
      await db.query(`INSERT INTO intake.trip_leg(tenant_id,id,trip_request_id,ordinal,origin_address_id,destination_address_id,planned_start_at,planned_end_at)
        VALUES ($1,$2,$3,1,$4,$5,'2026-09-13T16:00:00Z','2026-09-13T17:00:00Z')`, [tenantId, legId, tripId, origin, destination]);
      await db.query(`INSERT INTO dispatch.run(tenant_id,id,branch_id,service_date,service_timezone,planned_start_at,planned_end_at,lifecycle_reference)
        VALUES ($1,$2,$3,'2026-09-13','America/Los_Angeles','2026-09-13T15:00:00Z','2026-09-13T18:00:00Z','scheduled')`, [tenantId, runId, branch]);
      await db.query('INSERT INTO dispatch.run_leg(tenant_id,id,run_id,trip_leg_id,ordinal) VALUES ($1,$2,$3,$4,1)', [tenantId, randomUUID(), runId, legId]);
      await db.query('INSERT INTO dispatch.assignment(tenant_id,id,run_id,driver_id,vehicle_id) VALUES ($1,$2,$3,$4,$5)', [tenantId, assignmentId, runId, driverId, vehicle]);
    });
    const reader = createDriverItineraryReader(pool);
    const legs = await reader(tenantId, driverId, '2026-09-13');
    assert.equal(legs.length, 1); assert.equal(legs[0].tripLegId, legId); assert.equal(legs[0].pickupLabel, 'Synthetic pickup');
    assert.equal(legs[0].execution, null, 'an assignment must not fabricate dispatched execution');
    assert.deepEqual(await reader(tenantId, otherDriver, '2026-09-13'), []);
    assert.deepEqual(await reader(syntheticIds.organizationB, driverId, '2026-09-13'), []);
    assert.deepEqual(await reader(tenantId, driverId, '2026-09-14'), []);
    const shift = createPostgresDriverShiftService(pool);
    const application = createWp007PostgresApplication(pool, { etagSecret: 'synthetic-etag-secret-driver-actions-local-0001' });
    // JS timestamps have millisecond precision; DB recorded_at has microseconds.
    // Also prove a slightly lagging application clock cannot violate DB retention.
    let driverClockOffset = -10;
    const actionService=createPostgresDriverActionService(pool,{etag:application.etag,now:()=>new Date(Date.now()+driverClockOffset)});
    app = await createWp007Api({ application, driverItineraryReader: reader, driverShiftService: shift,
      driverSignatureService: createPostgresDriverSignatureService(pool,{etag:application.etag}),
      driverActionService: actionService, driverPrecheckService: createPostgresDriverPrecheckService(pool),
      driverShiftReader: createPostgresDriverShiftStateReader(pool) });
    const result = await app.inject({ url: `/v1/organizations/${tenantId}/driver/itineraries/2026-09-13`, headers: { authorization: 'Synthetic principal_driver' } });
    assert.equal(result.statusCode, 200, result.body); assert.equal(result.json().legs[0].assignmentId, assignmentId);
    const shiftUrl = `/v1/organizations/${tenantId}/driver/shifts/commands/start`;
    const shiftHeaders = { authorization: 'Synthetic principal_driver', 'idempotency-key': 'persisted-shift-start-0001' };
    const shiftBody = { assignmentId, serviceDate: '2026-09-13', expectedAssignmentVersion: 1 };
    const stale = await app.inject({ method: 'POST', url: shiftUrl, headers: { ...shiftHeaders, 'idempotency-key': 'persisted-shift-stale-0001' }, payload: { ...shiftBody, expectedAssignmentVersion: 2 } });
    assert.equal(stale.statusCode, 412, stale.body);
    const started = await app.inject({ method: 'POST', url: shiftUrl, headers: shiftHeaders, payload: shiftBody });
    assert.equal(started.statusCode, 200, started.body); assert.equal(started.json().outcome, 'APPLIED');
    assert.equal(started.json().effectivePolicy.commercialTier, 'ENTERPRISE');
    assert.equal(started.json().effectivePolicy.driverId, driverId); assert.equal(started.json().effectivePolicy.assignmentId, assignmentId);
    const replayed = await app.inject({ method: 'POST', url: shiftUrl, headers: shiftHeaders, payload: shiftBody });
    assert.equal(replayed.statusCode, 200, replayed.body); assert.equal(replayed.json().outcome, 'REPLAYED');
    assert.equal(replayed.json().shiftReference, started.json().shiftReference);
    assert.equal(replayed.headers['kavaroutes-idempotency-replayed'], 'true');
    const duplicate = await app.inject({ method: 'POST', url: shiftUrl, headers: { ...shiftHeaders, 'idempotency-key': 'persisted-shift-start-0002' }, payload: shiftBody });
    assert.equal(duplicate.statusCode, 409, duplicate.body);
    const evidence = await withTenantTransaction(pool, tenantId, 'kavaroutes_api', async db => ({
      snapshots: Number((await db.query('SELECT count(*) FROM execution.shift_policy_snapshot WHERE tenant_id=$1 AND driver_id=$2', [tenantId, driverId])).rows[0].count),
      audits: Number((await db.query("SELECT count(*) FROM audit.event WHERE tenant_id=$1 AND action_reference='driver.shift.started'", [tenantId])).rows[0].count),
      messages: Number((await db.query("SELECT count(*) FROM outbox.message WHERE tenant_id=$1 AND event_type='DriverShiftStarted'", [tenantId])).rows[0].count),
      deliveries: Number((await db.query("SELECT count(*) FROM outbox.delivery WHERE tenant_id=$1 AND job_type='kr.realtime-signal.driver-shift.v1'", [tenantId])).rows[0].count),
    }));
    assert.deepEqual(evidence, { snapshots: 1, audits: 1, messages: 1, deliveries: 1 });
    const actionId = randomUUID();
    const insertReceipt = (db, id = actionId) => db.query(`INSERT INTO execution.driver_action_receipt
      (tenant_id,client_action_id,shift_id,sequence_number,idempotency_key,command_fingerprint,command_reference,
       resource_reference,outcome,resource_version,captured_at)
      VALUES ($1,$2,$3,1,'driver-action-receipt-0001',$4,'ARRIVE_PICKUP',$5,'APPLIED',2,now())`,
      [tenantId,id,started.json().shiftReference,'a'.repeat(64),legId]);
    await withTenantTransaction(pool, tenantId, 'kavaroutes_api', db => insertReceipt(db));
    await assert.rejects(() => withTenantTransaction(pool, tenantId, 'kavaroutes_api', db => insertReceipt(db, randomUUID())),
      error => error.kind === 'duplicate');
    const receiptRows = await withTenantTransaction(pool, tenantId, 'kavaroutes_api', db =>
      db.query('SELECT outcome,resource_version FROM execution.driver_action_receipt WHERE client_action_id=$1', [actionId]));
    assert.equal(receiptRows.rows[0].outcome, 'APPLIED');
    assert.equal(Number(receiptRows.rows[0].resource_version), 2);
    assert.equal((await withTenantTransaction(pool, syntheticIds.organizationB, 'kavaroutes_api', db =>
      db.query('SELECT client_action_id FROM execution.driver_action_receipt'))).rowCount, 0);
    await assert.rejects(() => pool.query('UPDATE execution.driver_action_receipt SET resource_version=3 WHERE client_action_id=$1', [actionId]),
      error => error.code === '23514');
    await assert.rejects(() => pool.query('DELETE FROM execution.driver_action_receipt WHERE client_action_id=$1', [actionId]),
      error => error.code === '23514');
    const persistence = createPostgresPersistence(pool);
    const runTransaction = (effect, owner = tenantId) => persistence.executeIdempotentMutation({ tenantId: owner,
      actorReference: 'principal_driver', operationId: 'driverActionRepositoryTest', key: randomUUID(),
      fingerprint: 'b'.repeat(64), recordId: randomUUID(), expiresAt: new Date(Date.now() + 86_700_000), isolationLevel: 'serializable' },
      async transaction => ({ statusCode: 200, body: (await effect(transaction)) ?? null, headers: {}, resultReference: actionId }));
    const shiftId = started.json().shiftReference;
    const nextAction = { shiftId, clientActionId: randomUUID(), sequence: 2, idempotencyKey: 'driver-action-receipt-0002',
      fingerprint: 'c'.repeat(64), command: 'ARRIVE_PICKUP', resourceReference: legId,
      outcome: 'REJECTED', resourceVersion: null, reasonCode: 'PRECHECK_REQUIRED', capturedAt: new Date() };
    await assert.rejects(() => runTransaction(tx => tx.appendDriverActionReceipt(nextAction)), /DRIVER_SHIFT_LOCK_REQUIRED/);
    const inaccessible = await runTransaction(tx => tx.lockDriverActionShift({ shiftId, driverId: otherDriver }));
    assert.equal(inaccessible.body, null);
    const appended = await runTransaction(async tx => {
      const context = await tx.lockDriverActionShift({ shiftId, driverId });
      assert.equal(context.assignmentId, assignmentId); assert.equal(context.lastSequence, 1);
      await tx.appendDriverActionReceipt(nextAction);
      return tx.readDriverActionReceipt(nextAction);
    });
    assert.equal(appended.body.outcome, 'REJECTED');
    assert.equal(appended.body.fingerprint, nextAction.fingerprint);
    await assert.rejects(() => runTransaction(async tx => {
      await tx.lockDriverActionShift({ shiftId, driverId });
      await tx.appendDriverActionReceipt({ ...nextAction, clientActionId: randomUUID(), sequence: 4, idempotencyKey: 'driver-action-gap-test-0004' });
    }), error => error.kind === 'stale-version');
    const restoredReceipt = await runTransaction(async tx => {
      const context = await tx.lockDriverActionShift({ shiftId, driverId });
      assert.equal(context.lastSequence, 2);
      return tx.readDriverActionReceipt(nextAction);
    });
    assert.deepEqual(restoredReceipt.body, appended.body);
    const executionId = randomUUID();
    await withTenantTransaction(pool, tenantId, 'kavaroutes_api', db => db.query(`INSERT INTO execution.leg_execution
      (tenant_id,id,trip_leg_id,run_id,lifecycle_reference,occurred_at) VALUES ($1,$2,$3,$4,'dispatched',now())`,
      [tenantId,executionId,legId,runId]));
    const executionWrite = { shiftId, tripLegId: legId, executionId, expectedVersion: 1,
      expectedLifecycle: 'DISPATCHED', lifecycle: 'EN_ROUTE_PICKUP', occurredAt: new Date() };
    await assert.rejects(() => runTransaction(tx => tx.readDriverLegExecution({ shiftId, tripLegId: legId })), /DRIVER_SHIFT_LOCK_REQUIRED/);
    await assert.rejects(() => runTransaction(tx => tx.updateDriverLegExecution(executionWrite)), /DRIVER_EXECUTION_LOCK_REQUIRED/);
    await runTransaction(async tx => {
      await tx.lockDriverActionShift({ shiftId, driverId });
      assert.equal(await tx.readDriverLegExecution({ shiftId, tripLegId: randomUUID() }), null);
      const execution = await tx.readDriverLegExecution({ shiftId, tripLegId: legId });
      assert.deepEqual(execution, { executionId, lifecycle: 'DISPATCHED', version: 1 });
      await assert.rejects(() => tx.updateDriverLegExecution({ ...executionWrite, expectedVersion: 2 }), error => error.kind === 'stale-version');
    });
    const executionReceipt = { ...nextAction, clientActionId: randomUUID(), sequence: 3,
      idempotencyKey: 'driver-execution-transaction-0003', command: 'MARK_EN_ROUTE', outcome: 'APPLIED', resourceVersion: 2, reasonCode: null };
    const changeExecution = async (tx, fail) => {
      await tx.lockDriverActionShift({ shiftId, driverId });
      await tx.readDriverLegExecution({ shiftId, tripLegId: legId });
      assert.equal(await tx.updateDriverLegExecution(executionWrite), 2);
      await tx.appendDriverActionReceipt(executionReceipt);
      if (fail) throw new Error('ROLLBACK_EXECUTION_RECEIPT');
    };
    await assert.rejects(() => runTransaction(tx => changeExecution(tx, true)), /ROLLBACK_EXECUTION_RECEIPT/);
    assert.equal((await reader(tenantId, driverId, '2026-09-13'))[0].execution.version, 1);
    await runTransaction(async tx => {
      await tx.lockDriverActionShift({ shiftId, driverId });
      assert.equal(await tx.readDriverActionReceipt(executionReceipt), null);
    });
    await runTransaction(tx => changeExecution(tx, false));
    const changedLegs = await reader(tenantId, driverId, '2026-09-13');
    assert.equal(changedLegs[0].execution.executionId,executionId);assert.equal(changedLegs[0].execution.lifecycle,'EN_ROUTE_PICKUP');assert.equal(changedLegs[0].execution.version,2);
    const refreshed = await app.inject({ url: `/v1/organizations/${tenantId}/driver/itineraries/2026-09-13`, headers: { authorization: 'Synthetic principal_driver' } });
    assert.deepEqual(refreshed.json().legs[0].execution, { ...changedLegs[0].execution,
      expectedTag: application.etag(executionId, 2, 'driver-execution-v1') });
    const actionUrl = `/v1/organizations/${tenantId}/driver/action-batches`;
    const actionHeaders = { authorization: 'Synthetic principal_driver', 'idempotency-key': 'driver-action-batch-strict-0001' };
    const arrival = { clientActionId: randomUUID(), deviceEpoch: 1, sequence: 4, capturedAt: new Date().toISOString(),
      resourceReference: legId, expectedTag: refreshed.json().legs[0].execution.expectedTag,
      idempotencyKey: 'driver-action-arrival-strict-0004', command: 'ARRIVE_PICKUP' };
    const strictBatch = { deviceSessionId: randomUUID(), shiftReference: shiftId,
      shiftGeneration: started.json().shiftGeneration, items: [arrival] };
    const send = (payload, key = randomUUID()) => app.inject({ method: 'POST', url: actionUrl,
      headers: { ...actionHeaders, 'idempotency-key': key }, payload });
    const strict = await send(strictBatch, actionHeaders['idempotency-key']);
    assert.equal(strict.statusCode, 200, strict.body);
    assert.deepEqual(strict.json().items, [{ clientItemId: arrival.clientActionId, outcome: 'REJECTED', code: 'PRECHECK_REQUIRED' }]);
    const sameBatch = await send(strictBatch, actionHeaders['idempotency-key']);
    assert.deepEqual(sameBatch.json(), strict.json());
    assert.equal(sameBatch.headers['kavaroutes-idempotency-replayed'], 'true');
    const regrouped = await send(strictBatch);
    assert.deepEqual(regrouped.json().items, strict.json().items, 'rejected replay must never appear APPLIED');
    const tampered = await send({ ...strictBatch, items: [{ ...arrival, resourceReference: randomUUID() }] });
    assert.equal(tampered.statusCode, 422, tampered.body);
    const missingBinding = await send({ deviceSessionId: strictBatch.deviceSessionId, items: [arrival] });
    assert.equal(missingBinding.statusCode, 422, missingBinding.body);
    const wrongGeneration = await send({ ...strictBatch, shiftGeneration: randomUUID() });
    assert.equal(wrongGeneration.statusCode, 404, wrongGeneration.body);
    const unsupported = await send({ ...strictBatch, items: [{ ...arrival, command: 'COMPLETE_PRECHECK',policyDigest: started.json().effectivePolicy.canonicalDigest }] });
    assert.equal(unsupported.statusCode, 503, unsupported.body);
    assert.equal((await reader(tenantId, driverId, '2026-09-13'))[0].execution.version, 2);

    const entries = precheckItems.map(item => ({ item, response: 'NO_DEFECT' }));
    const precheckPayload = (shiftReceipt, expectedVersion) => ({ shiftGeneration: shiftReceipt.shiftGeneration,
      vehicleId: legs[0].vehicleId, policyDigest: shiftReceipt.effectivePolicy.canonicalDigest, expectedVersion,
      capturedAt: new Date().toISOString(), photos: [],
      inspection: { decision: 'COMPLETED', definitionVersion: 'inspection-synthetic-v2', entries },
      odometer: { decision: 'COMPLETED', value: 10420, fuelLevel: 'FULL' } });
    const submitCheck = (shift, payload, key = randomUUID(), authorization = 'Synthetic principal_driver') => app.inject({ method: 'POST',
      url: `/v1/organizations/${tenantId}/driver/shifts/${shift}/commands/precheck`,
      headers: { authorization, 'idempotency-key': key }, payload });
    const strictCheck = precheckPayload(started.json(), 2);
    assert.equal((await submitCheck(shiftId, { ...strictCheck, vehicleId: randomUUID() })).statusCode, 422);
    assert.equal((await submitCheck(shiftId, { ...strictCheck, policyDigest: '0'.repeat(64) })).statusCode, 422);
    assert.equal((await submitCheck(shiftId, { ...strictCheck, expectedVersion: 1 })).statusCode, 412);
    assert.equal((await submitCheck(shiftId, strictCheck, randomUUID(), 'Synthetic principal_dispatcher')).statusCode, 404);
    const skipControl = { decision: 'SKIPPED', reason: 'OPTIONAL_CONTROL_SKIPPED' };
    assert.equal((await submitCheck(shiftId, { ...strictCheck, inspection: skipControl })).statusCode, 422);
    assert.equal((await submitCheck(shiftId, { ...strictCheck, inspection: { ...strictCheck.inspection,
      entries: entries.map((entry, index) => index === 19 ? entries[0] : entry) } })).statusCode, 422);
    assert.equal((await submitCheck(shiftId, { ...strictCheck, inspection: { ...strictCheck.inspection,
      entries: entries.map((entry, index) => index === 0 ? { ...entry, response: 'DEFECT_FOUND', severity: 'MINOR', note: 'Synthetic scratch', photoDigest: 'a'.repeat(64) } : entry) } })).statusCode, 422);
    const checkKey = randomUUID();
    const acceptedCheck = await submitCheck(shiftId, strictCheck, checkKey);
    assert.equal(acceptedCheck.statusCode, 200, acceptedCheck.body);
    assert.deepEqual(acceptedCheck.json(), { shiftReference: shiftId, vehicleId: legs[0].vehicleId, resourceVersion: 3,
      inspectionOutcome: 'COMPLETED', odometerOutcome: 'COMPLETED', vehicleState: 'READY', odometer: 10420, fuelLevel: 'FULL' });
    const checkReplay = await submitCheck(shiftId, strictCheck, checkKey);
    assert.deepEqual(checkReplay.json(), acceptedCheck.json());
    assert.equal(checkReplay.headers['kavaroutes-idempotency-replayed'], 'true');
    const shiftReadUrl = `/v1/organizations/${tenantId}/driver/shifts/assignments/${assignmentId}`;
    const getShift = await app.inject({ url: shiftReadUrl, headers: { authorization: 'Synthetic principal_driver' } });
    assert.equal(getShift.statusCode, 200, getShift.body);
    assert.equal(getShift.json().resourceVersion, 3); assert.deepEqual(getShift.json().precheck, acceptedCheck.json());
    assert.equal((await app.inject({ url: shiftReadUrl, headers: { authorization: 'Synthetic principal_facility' } })).statusCode, 404);
    assert.equal((await submitCheck(shiftId, { ...strictCheck, expectedVersion: 3 })).statusCode, 409);
    await assert.rejects(() => pool.query('UPDATE execution.driver_precheck_decision SET odometer=1 WHERE tenant_id=$1', [tenantId]), error => error.code === '23514');
    assert.equal((await withTenantTransaction(pool, syntheticIds.organizationB, 'kavaroutes_api', db => db.query('SELECT * FROM execution.driver_precheck_decision'))).rowCount, 0);

    // A genuinely different, server-resolved next-shift policy; never weaken the pinned active snapshot.
    await runTransaction(tx => tx.replaceDriverControlPolicy({ policyId: randomUUID(), organizationId: tenantId,
      expectedVersion: 1, controls: { preInspection: 'DISABLED', startOdometer: 'DISABLED' }, locks: {},
      reasonCode: 'OPERATING_POLICY_CHANGED', actorId: syntheticIds.dispatcher }));
    await withTenantTransaction(pool, tenantId, 'kavaroutes_api', db => db.query(
      "UPDATE execution.shift_policy_snapshot SET lifecycle='SHIFT_ENDED' WHERE tenant_id=$1 AND id=$2", [tenantId,shiftId]));
    const nextShiftResponse = await app.inject({ method: 'POST', url: shiftUrl,
      headers: { ...shiftHeaders, 'idempotency-key': 'persisted-shift-next-policy-0001' }, payload: shiftBody });
    assert.equal(nextShiftResponse.statusCode, 200, nextShiftResponse.body);
    const nextShift = nextShiftResponse.json();
    assert.equal(nextShift.effectivePolicy.preInspection.mode, 'DISABLED');
    const disabledCheck = precheckPayload(nextShift, 1); delete disabledCheck.inspection; delete disabledCheck.odometer;
    const disabled = await submitCheck(nextShift.shiftReference, disabledCheck);
    assert.equal(disabled.statusCode, 200, disabled.body);
    assert.equal(disabled.json().inspectionOutcome, 'NOT_REQUIRED'); assert.equal(disabled.json().odometerOutcome, 'NOT_REQUIRED');
    assert.equal(disabled.json().odometer, null);
    const allowedArrival = { ...arrival, clientActionId: randomUUID(), sequence: 1, idempotencyKey: 'driver-action-arrival-allowed-0001' };
    const allowedBatch = { ...strictBatch, shiftReference: nextShift.shiftReference, shiftGeneration: nextShift.shiftGeneration, items: [allowedArrival] };
    const committed = await send(allowedBatch);
    assert.equal(committed.statusCode, 200, committed.body);
    assert.deepEqual(committed.json().items, [{ clientItemId: allowedArrival.clientActionId, outcome: 'APPLIED', resourceVersion: 3 }]);
    const replayedAction = await send(allowedBatch);
    assert.deepEqual(replayedAction.json().items, [{ clientItemId: allowedArrival.clientActionId, outcome: 'REPLAYED', resourceVersion: 3 }]);
    const stateAfterAction = (await reader(tenantId, driverId, '2026-09-13'))[0].execution;
    assert.equal(stateAfterAction.executionId,executionId);assert.equal(stateAfterAction.lifecycle,'ARRIVED_PICKUP');assert.equal(stateAfterAction.version,3);
    const gap = await send({ ...allowedBatch, items: [{ ...allowedArrival, clientActionId: randomUUID(), sequence: 3, idempotencyKey: 'driver-action-gap-0003' }] });
    assert.equal(gap.statusCode, 409, gap.body);
    const actionEvidence = await withTenantTransaction(pool, tenantId, 'kavaroutes_api', async db => ({
      events: Number((await db.query("SELECT count(*) FROM outbox.message WHERE tenant_id=$1 AND event_type='DriverActionRecorded'", [tenantId])).rows[0].count),
      audits: Number((await db.query("SELECT count(*) FROM audit.event WHERE tenant_id=$1 AND action_reference IN ('driver.action.applied','driver.action.rejected')", [tenantId])).rows[0].count),
    }));
    assert.deepEqual(actionEvidence, { events: 2, audits: 2 });
    await verifyDriverServiceProof({pool,app,tenantId,driverId,legId,tripId,runId,shift:nextShift,application,
      advanceClock:()=>{driverClockOffset+=16*60000;}});
    const createPolicyShift = async (prior, policyVersion, mode, label) => {
      await runTransaction(tx => tx.replaceDriverControlPolicy({ policyId: randomUUID(), organizationId: tenantId,
        expectedVersion: policyVersion, controls: { preInspection: mode, startOdometer: mode }, locks: {},
        reasonCode: 'OPERATING_POLICY_CHANGED', actorId: syntheticIds.dispatcher }));
      await withTenantTransaction(pool, tenantId, 'kavaroutes_api', db => db.query(
        "UPDATE execution.shift_policy_snapshot SET lifecycle='SHIFT_ENDED' WHERE tenant_id=$1 AND id=$2", [tenantId,prior.shiftReference]));
      const response = await app.inject({ method: 'POST', url: shiftUrl,
        headers: { ...shiftHeaders, 'idempotency-key': `persisted-shift-policy-${label}` }, payload: shiftBody });
      assert.equal(response.statusCode, 200, response.body); return response.json();
    };
    const optionalShift = await createPolicyShift(nextShift, 2, 'OPTIONAL', 'optional-0001');
    const optionalPayload = { ...precheckPayload(optionalShift, 1), inspection: skipControl, odometer: skipControl };
    const optional = await submitCheck(optionalShift.shiftReference, optionalPayload);
    assert.equal(optional.statusCode, 200, optional.body);
    assert.equal(optional.json().inspectionOutcome, 'SKIPPED'); assert.equal(optional.json().odometerOutcome, 'SKIPPED');
    const photoShift = await createPolicyShift(optionalShift, 3, 'OPTIONAL', 'photo-0001');
    // Locally generated 8x8 white JPEG: no person, vehicle, document or provider data.
    const photoBase64 = '/9j/4AAQSkZJRgABAQAAAQABAAD/2wCEAAEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAf/AABEIAAgACAMBEQACEQEDEQH/xAGiAAABBQEBAQEBAQAAAAAAAAAAAQIDBAUGBwgJCgsQAAIBAwMCBAMFBQQEAAABfQECAwAEEQUSITFBBhNRYQcicRQygZGhCCNCscEVUtHwJDNicoIJChYXGBkaJSYnKCkqNDU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6g4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2drh4uPk5ebn6Onq8fLz9PX29/j5+gEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoLEQACAQIEBAMEBwUEBAABAncAAQIDEQQFITEGEkFRB2FxEyIygQgUQpGhscEJIzNS8BVictEKFiQ04SXxFxgZGiYnKCkqNTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqCg4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2dri4+Tl5ufo6ery8/T19vf4+fr/2gAMAwEAAhEDEQA/AP7+KAP/2Q==';
    const photoDigest = createHash('sha256').update(`DEFECT_PHOTO:${photoBase64}`).digest('hex');
    const photoPayload = precheckPayload(photoShift, 1);
    const defect = { ...entries[0], response: 'DEFECT_FOUND', severity: 'MINOR', note: 'Synthetic scratch', photoDigest };
    photoPayload.inspection.entries = entries.map((entry, index) => index === 0 ? defect : entry);
    photoPayload.photos = [{ digest: photoDigest, base64: photoBase64 }];
    const fakeJpeg = Buffer.alloc(100); fakeJpeg.set([255,216,255]); fakeJpeg.set([255,217], 98);
    const fakeBase64 = fakeJpeg.toString('base64'); const fakeDigest = createHash('sha256').update(`DEFECT_PHOTO:${fakeBase64}`).digest('hex');
    assert.equal((await submitCheck(photoShift.shiftReference, { ...photoPayload, photos: [{ digest: fakeDigest, base64: fakeBase64 }],
      inspection: { ...photoPayload.inspection, entries: entries.map((entry, index) => index === 0 ? { ...defect, photoDigest: fakeDigest } : entry) } })).statusCode, 422);
    assert.equal((await submitCheck(photoShift.shiftReference, { ...photoPayload, photos: [{ digest: photoDigest, base64: Buffer.alloc(100).toString('base64') }] })).statusCode, 422);
    const wrongDigest = '0'.repeat(64);
    assert.equal((await submitCheck(photoShift.shiftReference, { ...photoPayload, photos: [{ digest: wrongDigest, base64: photoBase64 }],
      inspection: { ...photoPayload.inspection, entries: entries.map((entry, index) => index === 0 ? { ...defect, photoDigest: wrongDigest } : entry) } })).statusCode, 422);
    assert.equal((await submitCheck(photoShift.shiftReference, { ...photoPayload,
      inspection: { ...photoPayload.inspection, entries: entries.map((entry, index) => index < 2 ? { ...defect, item: entry.item } : entry) } })).statusCode, 422);
    const photoKey = randomUUID();
    const photoCheck = await submitCheck(photoShift.shiftReference, photoPayload, photoKey);
    assert.equal(photoCheck.statusCode, 200, photoCheck.body); assert.equal(photoCheck.json().inspectionOutcome, 'COMPLETED');
    const photoEvidence = await withTenantTransaction(pool, tenantId, 'kavaroutes_api', db => db.query(
      'SELECT digest,content FROM execution.driver_precheck_photo WHERE tenant_id=$1 AND shift_id=$2', [tenantId,photoShift.shiftReference]));
    assert.equal(photoEvidence.rowCount, 1); assert.equal(photoEvidence.rows[0].digest, photoDigest);
    assert.equal(photoEvidence.rows[0].content.toString('base64'), photoBase64);
    assert.equal((await withTenantTransaction(pool, syntheticIds.organizationB, 'kavaroutes_api', db => db.query('SELECT * FROM execution.driver_precheck_photo'))).rowCount, 0);
    await assert.rejects(() => pool.query('DELETE FROM execution.driver_precheck_photo WHERE tenant_id=$1', [tenantId]), error => error.code === '23514');
    const reconstructedPrecheck = createPostgresDriverPrecheckService(pool);
    const reconstructedResult = await reconstructedPrecheck.submit({ organizationId: tenantId, shiftId: photoShift.shiftReference,
      principal: { id: syntheticIds.driver, organizationId: tenantId, subjectId: driverId, capabilities: new Set(['driver:execute']), purposes: new Set(['ASSIGNED_SERVICE_DELIVERY']) },
      key: photoKey, request: photoPayload });
    assert.deepEqual(reconstructedResult.body, photoCheck.json());
    const criticalShift = await createPolicyShift(photoShift, 4, 'REQUIRED', 'critical-0001');
    const criticalPayload = precheckPayload(criticalShift, 1);
    criticalPayload.inspection.entries = entries.map((entry, index) => index === 0 ? { ...entry, response: 'DEFECT_FOUND',
      severity: 'CRITICAL_OUT_OF_SERVICE', note: 'Synthetic brake fault', photoException: 'UNSAFE_TO_CAPTURE' } : entry);
    const criticalCheck = await submitCheck(criticalShift.shiftReference, criticalPayload);
    assert.equal(criticalCheck.statusCode, 200, criticalCheck.body);
    assert.equal(criticalCheck.json().vehicleState, 'BLOCKED_CRITICAL_DEFECT');
    const blockedAction = { ...allowedArrival, clientActionId: randomUUID(), command: 'MARK_EN_ROUTE', sequence: 1,
      idempotencyKey: 'driver-critical-release-block-0001', expectedTag: application.etag(executionId, 3, 'driver-execution-v1') };
    // Restoring a dispatched fixture is explicit test setup, never an application shortcut.
    await withTenantTransaction(pool, tenantId, 'kavaroutes_api', db => db.query(
      "UPDATE execution.leg_execution SET lifecycle_reference='dispatched' WHERE tenant_id=$1 AND id=$2", [tenantId,executionId]));
    const blocked = await send({ ...allowedBatch, shiftReference: criticalShift.shiftReference,
      shiftGeneration: criticalShift.shiftGeneration, items: [blockedAction] });
    assert.equal(blocked.statusCode, 200, blocked.body);
    assert.equal(blocked.json().items[0].code, 'CRITICAL_DEFECT_BLOCKS_RELEASE');
    assert.equal((await reader(tenantId, driverId, '2026-09-13'))[0].execution.lifecycle, 'DISPATCHED');
    const attemptedBypass = await createPolicyShift(criticalShift, 5, 'DISABLED', 'critical-bypass-0001');
    const bypassCheck = precheckPayload(attemptedBypass, 1); delete bypassCheck.inspection; delete bypassCheck.odometer;
    const bypassResponse = await submitCheck(attemptedBypass.shiftReference, bypassCheck);
    assert.equal(bypassResponse.statusCode, 409, bypassResponse.body);
    assert.equal(bypassResponse.json().code, 'CRITICAL_DEFECT_BLOCKS_RELEASE');
    // Synthetic historical row models clock rollback: a closed shift's timestamp
    // must not hide the actual open shift during assignment-scoped recovery.
    await pool.query(`INSERT INTO execution.shift_policy_snapshot
      (tenant_id,id,assignment_id,driver_id,shift_generation,policy_version,policy_digest,effective_policy,pinned_assignment_version,lifecycle,pinned_at)
      SELECT tenant_id,$3,assignment_id,driver_id,$4,policy_version,policy_digest,effective_policy,pinned_assignment_version,'SHIFT_ENDED',now()+interval '1 hour'
      FROM execution.shift_policy_snapshot WHERE tenant_id=$1 AND id=$2`,[tenantId,criticalShift.shiftReference,randomUUID(),randomUUID()]);
    assert.equal((await app.inject({url:shiftReadUrl,headers:{authorization:'Synthetic principal_driver'}})).json().shiftReference,attemptedBypass.shiftReference);
    await assert.rejects(() => pool.query('UPDATE execution.shift_policy_snapshot SET pinned_assignment_version=2 WHERE tenant_id=$1 AND id=$2', [tenantId,attemptedBypass.shiftReference]), error => error.code === '23514');
    await withTenantTransaction(pool, tenantId, 'kavaroutes_api', db => db.query('UPDATE dispatch.assignment SET aggregate_version=2 WHERE tenant_id=$1 AND id=$2', [tenantId,assignmentId]));
    const revokedBinding = await app.inject({ url: shiftReadUrl,headers: { authorization: 'Synthetic principal_driver' } });
    assert.equal(revokedBinding.json().lifecycle,'INVALIDATE_REVIEW',JSON.stringify({expectedShift:attemptedBypass.shiftReference,actual:revokedBinding.json(),shifts:(await pool.query('SELECT id,lifecycle,pinned_at FROM execution.shift_policy_snapshot WHERE tenant_id=$1 AND assignment_id=$2 ORDER BY pinned_at DESC,id DESC',[tenantId,assignmentId])).rows}));
    const revokedAction = { ...blockedAction,clientActionId: randomUUID(),idempotencyKey: 'driver-edited-assignment-denied-0001' };
    const deniedEdit = await send({ ...allowedBatch,shiftReference: attemptedBypass.shiftReference,shiftGeneration: attemptedBypass.shiftGeneration,items: [revokedAction] });
    assert.equal(deniedEdit.statusCode,200,deniedEdit.body);assert.equal(deniedEdit.json().items[0].code,'DRIVER_SHIFT_NOT_ACTIVE');
    const sequenceRead = await app.inject({ url: shiftReadUrl,headers: { authorization: 'Synthetic principal_driver' } });
    assert.equal(sequenceRead.json().lastActionSequence,1);
    const realtimeSource = await withTenantTransaction(pool, tenantId, 'kavaroutes_outbox_consumer', async db => (await db.query(`SELECT r.service_date::text
      FROM outbox.message m
      JOIN execution.shift_policy_snapshot s ON s.tenant_id=m.tenant_id AND s.id=m.aggregate_id
      JOIN dispatch.assignment a ON a.tenant_id=s.tenant_id AND a.id=s.assignment_id
      JOIN dispatch.run r ON r.tenant_id=a.tenant_id AND r.id=a.run_id
      WHERE m.tenant_id=$1 AND m.event_type='DriverShiftStarted'`, [tenantId])).rows[0]);
    assert.equal(realtimeSource.service_date, '2026-09-13');
    await app.close(); app = undefined;
    // Reconstructing the read adapter yields the same database-backed result.
    assert.deepEqual(await createDriverItineraryReader(pool)(tenantId, driverId, '2026-09-13'), await reader(tenantId, driverId, '2026-09-13'));
    await withTenantTransaction(pool, tenantId, 'kavaroutes_api', db => db.query("UPDATE intake.trip_request SET lifecycle_reference='cancelled' WHERE tenant_id=$1 AND id=$2", [tenantId, tripId]));
    assert.deepEqual(await reader(tenantId, driverId, '2026-09-13'), []);
    const dispatchFixture=await verifyDispatchAuthority(pool,tenantId,runId);
    await verifyRouteProposals(pool,tenantId,dispatchFixture);
    const postFixture=await verifyDriverPostcheck(pool,tenantId,dispatchFixture.runId);
    await verifyDriverClosure(pool,tenantId,postFixture);
    const facilityTrip=(await pool.query('SELECT trip_request_id FROM intake.trip_leg WHERE tenant_id=$1 AND id=$2',[tenantId,dispatchFixture.legId])).rows[0].trip_request_id;
    await verifyFacilityDay(pool,tenantId,facilityTrip);
    assert.equal((await pool.query("SELECT count(*) FROM outbox.message WHERE retain_until<recorded_at+interval '30 days'")).rows[0].count,'0');
  } finally {
    if (app) await app.close(); if (pool) await pool.end();
    docker(['rm', '--force', name]);
  }
});
import {verifyFacilityDay} from './helpers/facility-day.mjs';
