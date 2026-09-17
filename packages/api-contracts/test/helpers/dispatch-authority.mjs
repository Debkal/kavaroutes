import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {applyDispatchAssignment,createDispatchBoardReader,createDriverItineraryReader,withTenantTransaction} from '../../../postgres-persistence/dist/index.js';
import {createWp007Api,createWp007PostgresApplication,createPostgresDispatchService} from '../../dist/index.js';

// Runs in the existing disposable PostGIS harness; no hosted data is touched.
export async function verifyDispatchAuthority(pool,tenantId,sourceRunId) {
 const runId=randomUUID(),legId=randomUUID(),tripId=randomUUID(),driverId=randomUUID(),otherDriver=randomUUID(),vehicleId=randomUUID();
 const firstAssignment=randomUUID();
 await withTenantTransaction(pool,tenantId,'kavaroutes_api',async db=>{
  await db.query("INSERT INTO fleet.driver(tenant_id,id,synthetic_reference) VALUES($1,$2::uuid,$2::uuid::text),($1,$3::uuid,$3::uuid::text)",[tenantId,driverId,otherDriver]);
  await db.query("INSERT INTO fleet.vehicle(tenant_id,id,synthetic_reference) VALUES($1,$2::uuid,$2::uuid::text)",[tenantId,vehicleId]);
  await db.query(`INSERT INTO dispatch.run(tenant_id,id,branch_id,service_date,service_timezone,planned_start_at,planned_end_at,lifecycle_reference)
   SELECT tenant_id,$3,branch_id,service_date,service_timezone,planned_start_at,planned_end_at,'planned' FROM dispatch.run WHERE tenant_id=$1 AND id=$2`,[tenantId,sourceRunId,runId]);
  await db.query(`INSERT INTO intake.trip_request(tenant_id,id,rider_id,service_date,service_timezone,local_service_time,resolved_service_at,resolved_utc_offset_seconds,ambiguity_policy,ambiguity_policy_version,lifecycle_reference)
   SELECT t.tenant_id,$3,t.rider_id,t.service_date,t.service_timezone,t.local_service_time,t.resolved_service_at,t.resolved_utc_offset_seconds,t.ambiguity_policy,t.ambiguity_policy_version,'draft'
   FROM intake.trip_request t JOIN intake.trip_leg l ON l.tenant_id=t.tenant_id AND l.trip_request_id=t.id JOIN dispatch.run_leg rl ON rl.tenant_id=l.tenant_id AND rl.trip_leg_id=l.id WHERE rl.tenant_id=$1 AND rl.run_id=$2 LIMIT 1`,[tenantId,sourceRunId,tripId]);
  await db.query(`INSERT INTO intake.trip_leg(tenant_id,id,trip_request_id,ordinal,origin_address_id,destination_address_id,planned_start_at,planned_end_at)
   SELECT l.tenant_id,$3,$4,1,l.origin_address_id,l.destination_address_id,l.planned_start_at,l.planned_end_at FROM intake.trip_leg l JOIN dispatch.run_leg rl ON rl.tenant_id=l.tenant_id AND rl.trip_leg_id=l.id WHERE rl.tenant_id=$1 AND rl.run_id=$2 LIMIT 1`,[tenantId,sourceRunId,legId,tripId]);
  await db.query('INSERT INTO dispatch.run_leg(tenant_id,id,run_id,trip_leg_id,ordinal) VALUES($1,$2,$3,$4,1)',[tenantId,randomUUID(),runId,legId]);
 });
 const assign=(expectedVersion,driver=driverId,assignmentId=randomUUID(),tenant=tenantId)=>withTenantTransaction(pool,tenant,'kavaroutes_api',db=>applyDispatchAssignment(db,tenant,{runId,expectedVersion,driverId:driver,vehicleId,assignmentId}),'serializable');
 await assert.rejects(()=>assign(1),e=>e.kind==='feasibility','missing capacity/rules fail closed; a dispatch refusal is a state conflict (409), not a hidden resource');
 // Administrator resolves explicit synthetic constraints, not a tier-derived default.
 await pool.query("INSERT INTO dispatch.run_service_requirements VALUES($1,$2,1,2,1,ARRAY['transport'],ARRAY[]::text[])",[tenantId,runId]);
 await pool.query('INSERT INTO fleet.vehicle_capacity VALUES($1,$2,1,0)',[tenantId,vehicleId]);
 await assert.rejects(()=>assign(1),e=>e.kind==='feasibility','insufficient vehicle capacity');
 await pool.query('UPDATE fleet.vehicle_capacity SET seats=2,wheelchair_spaces=1 WHERE tenant_id=$1 AND vehicle_id=$2',[tenantId,vehicleId]);
 await assert.rejects(()=>assign(1),e=>e.kind==='qualification','missing driver qualification');
 await pool.query("INSERT INTO fleet.qualification(tenant_id,id,driver_id,qualification_kind,valid_during) VALUES($1,$2,$3,'transport','[2026-01-01,2027-01-01)'),($1,$4,$5,'transport','[2026-01-01,2027-01-01)')",[tenantId,randomUUID(),driverId,randomUUID(),otherDriver]);
 await assert.rejects(()=>assign(1,driverId,randomUUID(),randomUUID()),e=>e.kind==='relationship','cross tenant fails');
 const first=await assign(1,driverId,firstAssignment);
 assert.equal(first.version,2);assert.equal(first.serviceDate,'2026-09-13');
 const itinerary=createDriverItineraryReader(pool);
 assert.equal((await itinerary(tenantId,driverId,first.serviceDate))[0].execution.lifecycle,'DISPATCHED');
 await assert.rejects(()=>assign(1,otherDriver),e=>e.kind==='stale-version');
 const replacement=await assign(2,otherDriver);
 assert.equal(replacement.supersedes,firstAssignment);
 assert.deepEqual(await itinerary(tenantId,driverId,first.serviceDate),[]);
 assert.equal((await itinerary(tenantId,otherDriver,first.serviceDate))[0].assignmentId,replacement.assignmentId);
 const board=await createDispatchBoardReader(pool)(tenantId,first.serviceDate);
 assert.equal(board.runs.find(r=>r.runId===runId).assignmentId,replacement.assignmentId);
 assert.equal((await createDispatchBoardReader(pool)(randomUUID(),first.serviceDate)).runs.length,0);
 assert.equal((await pool.query('SELECT count(*) FROM dispatch.assignment WHERE tenant_id=$1 AND run_id=$2',[tenantId,runId])).rows[0].count,'2','old binding retained');
 await assert.rejects(()=>withTenantTransaction(pool,tenantId,'kavaroutes_api',db=>db.query('DELETE FROM dispatch.assignment_supersession WHERE tenant_id=$1',[tenantId])));
 await assert.rejects(()=>pool.query('UPDATE dispatch.assignment SET aggregate_version=aggregate_version+1 WHERE tenant_id=$1 AND id=$2',[tenantId,firstAssignment]),e=>e.code==='23514');
 await pool.query("UPDATE execution.leg_execution SET lifecycle_reference='onboard' WHERE tenant_id=$1 AND run_id=$2",[tenantId,runId]);
 await assert.rejects(()=>assign(3,driverId),e=>e.kind==='work-started','onboard reassignment requires recovery');
 assert.equal((await pool.query('SELECT count(*) FROM dispatch.assignment WHERE tenant_id=$1 AND run_id=$2',[tenantId,runId])).rows[0].count,'2');
 // Exercise the HTTP authority and atomic receipt/audit/outbox path on pre-service work.
 await pool.query("UPDATE execution.leg_execution SET lifecycle_reference='dispatched' WHERE tenant_id=$1 AND run_id=$2",[tenantId,runId]);
 const application=createWp007PostgresApplication(pool,{etagSecret:'synthetic-etag-secret-dispatch-local-0001'});
 const api=await createWp007Api({application,dispatchService:createPostgresDispatchService(pool,{etag:application.etag})});
 try {
  const url=`/v1/organizations/${tenantId}/dispatch/runs/${runId}/commands/assign`;
  const headers={authorization:'Synthetic principal_dispatcher','idempotency-key':'synthetic-dispatch-command-0001','if-match':application.etag(runId,3,'dispatch-run-v1')};
  const payload={driverId,vehicleId,expectedVersion:3};
  const boardUrl=`/v1/organizations/${tenantId}/dispatch-board/2026-09-13`;
  assert.equal((await api.inject({url:boardUrl,headers})).statusCode,200);
  assert.equal((await api.inject({url:boardUrl,headers:{authorization:'Synthetic principal_facility'}})).statusCode,404);
  assert.equal((await api.inject({method:'POST',url,headers:{...headers,authorization:'Synthetic principal_driver'},payload})).statusCode,404);
  const {['if-match']:ignored,...missingTag}=headers;
  assert.equal((await api.inject({method:'POST',url,headers:missingTag,payload})).statusCode,428);
  const committed=await api.inject({method:'POST',url,headers,payload});
  assert.equal(committed.statusCode,200,committed.body);assert.equal(committed.json().version,4);
  const replay=await api.inject({method:'POST',url,headers,payload});
  assert.equal(replay.statusCode,200,replay.body);assert.deepEqual(replay.json(),committed.json());
  assert.equal(replay.headers['kavaroutes-idempotency-replayed'],'true');
  assert.equal((await api.inject({method:'POST',url,headers:{...headers,'idempotency-key':'synthetic-dispatch-stale-0001'},payload})).statusCode,412);
  const changed=await api.inject({method:'POST',url,headers,payload:{...payload,driverId:otherDriver}});
  assert.equal(changed.statusCode,422,changed.body);
  assert.equal(changed.json().code,'PERSISTENCE_IDEMPOTENCY_MISMATCH');
  const messages=await pool.query("SELECT aggregate_version,payload FROM outbox.message WHERE tenant_id=$1 AND aggregate_id=$2 AND event_type='DispatchAssignmentCommitted'",[tenantId,committed.json().assignmentId]);
  assert.equal(messages.rows.length,1);assert.equal(Number(messages.rows[0].aggregate_version),1);
  assert.deepEqual(messages.rows[0].payload,{runId,runVersion:4});
  assert.equal((await pool.query("SELECT count(*) FROM audit.event WHERE tenant_id=$1 AND aggregate_id=$2 AND action_reference='dispatch.assignment.committed'",[tenantId,runId])).rows[0].count,'1');
  const race=await Promise.all([0,1].map(index=>api.inject({method:'POST',url,headers:{...headers,'if-match':application.etag(runId,4,'dispatch-run-v1'),'idempotency-key':`synthetic-dispatch-race-000${index}`},payload:{...payload,expectedVersion:4,driverId:index?driverId:otherDriver}})));
  assert.equal(race.filter(r=>r.statusCode===200).length,1,'exactly one competing assignment commits');
  assert.ok(race.some(r=>[409,412].includes(r.statusCode)),race.map(r=>r.body).join('\n'));
  assert.equal((await pool.query('SELECT aggregate_version FROM dispatch.run WHERE tenant_id=$1 AND id=$2',[tenantId,runId])).rows[0].aggregate_version,'5');
 } finally {await api.close();}
 return {runId,legId,vehicleId};
}
