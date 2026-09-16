import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {withTenantTransaction} from '../../../postgres-persistence/dist/index.js';
import {signatureDigestInput,createPostgresDriverSignatureService,syntheticIds} from '../../dist/index.js';

export async function verifyDriverServiceProof({pool,app,tenantId,driverId,legId,runId,shift,application,advanceClock}) {
  let sequence=1,ordinal=1;
  const auth={authorization:'Synthetic principal_driver'};
  const rule={pickupRequired:true,dropoffRequired:true,mobilitySecurementRequired:true,allowedRoles:['RIDER','RIDER_UNABLE_TO_SIGN'],unableReasons:['PHYSICALLY_UNABLE'],
    noShowWaitMinutes:15,noShowAllowed:true,noShowAuthorizationReference:randomUUID()};
  const policyDigest=createHash('sha256').update(JSON.stringify(rule)).digest('hex');
  const freshLeg=async(proofRule=rule)=>{
    const id=randomUUID(),executionId=randomUUID();ordinal++;
    await withTenantTransaction(pool,tenantId,'kavaroutes_api',async db=>{
      await db.query(`INSERT INTO intake.trip_leg(tenant_id,id,trip_request_id,ordinal,origin_address_id,destination_address_id,planned_start_at,planned_end_at)
        SELECT tenant_id,$2,trip_request_id,$3,origin_address_id,destination_address_id,planned_start_at,planned_end_at FROM intake.trip_leg WHERE tenant_id=$1 AND id=$4`,[tenantId,id,ordinal,legId]);
      await db.query('INSERT INTO dispatch.run_leg(tenant_id,id,run_id,trip_leg_id,ordinal) VALUES($1,$2,$3,$4,$5)',[tenantId,randomUUID(),runId,id,ordinal]);
      await db.query("INSERT INTO execution.leg_execution(tenant_id,id,trip_leg_id,run_id,lifecycle_reference,occurred_at) VALUES($1,$2,$3,$4,'dispatched',now())",[tenantId,executionId,id,runId]);
    });
    if(proofRule)await withTenantTransaction(pool,tenantId,'kavaroutes_migration',db=>db.query('INSERT INTO execution.driver_leg_proof_rule(tenant_id,execution_id,policy_version,policy_digest,rule) VALUES($1,$2,1,$3,$4)',[tenantId,executionId,policyDigest,JSON.stringify(proofRule)]));
    return id;
  };
  const read=async id=>{const r=await app.inject({url:`/v1/organizations/${tenantId}/driver/itineraries/2026-09-13`,headers:auth});assert.equal(r.statusCode,200,r.body);return r.json().legs.find(l=>l.tripLegId===id);};
  const action=async(id,command,details={},code)=>{
    const leg=await read(id),item={...details,clientActionId:randomUUID(),deviceEpoch:1,sequence:++sequence,capturedAt:new Date().toISOString(),resourceReference:id,expectedTag:leg.execution.expectedTag,command,idempotencyKey:randomUUID()};
    const request={deviceSessionId:shift.shiftGeneration,shiftReference:shift.shiftReference,shiftGeneration:shift.shiftGeneration,items:[item]},key=randomUUID();
    const send=()=>app.inject({method:'POST',url:`/v1/organizations/${tenantId}/driver/action-batches`,headers:{...auth,'idempotency-key':key},payload:request});
    const result=await send();assert.equal(result.statusCode,200,result.body);
    if(code)assert.equal(result.json().items[0].code,code,result.body);else assert.equal(result.json().items[0].outcome,'APPLIED',result.body);
    assert.deepEqual((await send()).json(),result.json(),'lost response replay must preserve exact original receipt');
    return result.json();
  };
  const makeSignature=async(id,event,offset=0,extra={})=>{
    const leg=await read(id),now=new Date().toISOString();const unsigned={shiftGeneration:shift.shiftGeneration,evidenceId:randomUUID(),expectedTag:leg.execution.expectedTag,event,
      attestationPolicyVersion:'attestation-synthetic-v2',policyVersion:1,policyDigest,capturedAt:now,localActionAt:now,installationGeneration:'inst_synthetic0000001',parkedAttestation:true,role:'RIDER',
      points:Array.from({length:12},(_,i)=>[10+i*8+offset,10+(i%4)*9+offset]),...extra};
    return {...unsigned,digest:createHash('sha256').update(`SIGNATURE:${signatureDigestInput(shift.shiftReference,id,unsigned)}`).digest('hex')};
  };
  const signature=async(id,request,key=randomUUID(),authorization=auth.authorization)=>app.inject({method:'POST',url:`/v1/organizations/${tenantId}/driver/shifts/${shift.shiftReference}/legs/${id}/evidence/signatures`,headers:{authorization,'idempotency-key':key},payload:request});
  const id=await freshLeg();
  await action(id,'MARK_EN_ROUTE');await action(id,'ARRIVE_PICKUP');
  await action(id,'BOARD_RIDER',{},'BOARDING_CONTROLS_REQUIRED');
  await action(id,'SECURE_RIDER',{occupantRestraint:'SECURED',mobilityDevice:'SECURED'},'RIDER_VERIFICATION_REQUIRED');
  await action(id,'VERIFY_RIDER',{verificationMethod:'NAME_CONFIRMED_WITH_RIDER'});
  await action(id,'SECURE_RIDER',{occupantRestraint:'SECURED',mobilityDevice:'NOT_APPLICABLE'},'MOBILITY_SECUREMENT_REQUIRED');
  await action(id,'SECURE_RIDER',{occupantRestraint:'SECURED',mobilityDevice:'SECURED'});
  await action(id,'BOARD_RIDER',{},'PICKUP_PROOF_REQUIRED');
  const pickup=await makeSignature(id,'PICKUP_ATTESTATION');
  assert.equal((await signature(id,{...pickup,points:[]})).statusCode,422);
  assert.equal((await signature(id,{...pickup,digest:'0'.repeat(64)})).statusCode,422);
  assert.equal((await signature(id,{...pickup,policyDigest:'0'.repeat(64)})).statusCode,422);
  assert.equal((await signature(id,pickup,randomUUID(),'Synthetic principal_dispatcher')).statusCode,404);
  const key=randomUUID(),accepted=await signature(id,pickup,key);assert.equal(accepted.statusCode,200,accepted.body);
  assert.equal(accepted.json().status,'ACCEPTED_FOR_SERVICE_CONTROL');
  assert.deepEqual((await signature(id,pickup,key)).json(),accepted.json());
  const principal={id:syntheticIds.driver,organizationId:tenantId,subjectId:driverId,capabilities:new Set(['driver:execute']),purposes:new Set(['ASSIGNED_SERVICE_DELIVERY'])};
  const reconstructed=await createPostgresDriverSignatureService(pool,{etag:application.etag}).submit({organizationId:tenantId,shiftId:shift.shiftReference,legId:id,principal,key,request:pickup});
  assert.deepEqual(reconstructed.body,accepted.json());
  const replacement=await makeSignature(id,'PICKUP_ATTESTATION',3,{supersedesEvidenceId:pickup.evidenceId});
  const replaced=await signature(id,replacement);assert.equal(replaced.statusCode,200,replaced.body);
  assert.equal((await read(id)).execution.serviceControl.pickupEvidenceId,replacement.evidenceId);
  await action(id,'BOARD_RIDER');assert.equal((await read(id)).execution.lifecycle,'ONBOARD');
  await action(id,'REQUEST_CANCEL_LEG',{reason:'RIDER_REQUESTED'},'LEG_EXECUTION_TRANSITION_NOT_DECLARED');
  await action(id,'MARK_RIDER_NO_SHOW',{contactAttestation:'ATTEMPTED_NO_RESPONSE',authorizationReference:rule.noShowAuthorizationReference},'LEG_EXECUTION_TRANSITION_NOT_DECLARED');
  await action(id,'ARRIVE_DROPOFF');await action(id,'COMPLETE_LEG',{},'SAFE_UNLOAD_REQUIRED');
  await action(id,'UNLOAD_RIDER',{attestation:'UNLOADED_AND_ASSISTED'});await action(id,'COMPLETE_LEG',{},'SERVICE_PROOF_REQUIRED');
  const duplicateStroke=await makeSignature(id,'DROPOFF_ATTESTATION');const duplicateResult=await signature(id,duplicateStroke);
  assert.equal(duplicateResult.statusCode,409,duplicateResult.body);
  const dropoff=await makeSignature(id,'DROPOFF_ATTESTATION',0,{role:'RIDER_UNABLE_TO_SIGN',points:[],unableReason:'PHYSICALLY_UNABLE',witnessAttestation:'Synthetic witness confirms physical inability'});
  assert.equal((await signature(id,dropoff)).statusCode,200);await action(id,'COMPLETE_LEG');assert.equal((await read(id)).execution.lifecycle,'COMPLETED');
  const completedExecution=(await read(id)).execution.executionId;
  const ledger=await withTenantTransaction(pool,tenantId,'kavaroutes_api',db=>db.query(`SELECT p.evidence_record_id,p.revision_number FROM execution.driver_service_proof p JOIN execution.evidence_revision r ON r.tenant_id=p.tenant_id AND r.id=p.evidence_id WHERE p.tenant_id=$1 AND p.execution_id=$2 ORDER BY p.revision_number`,[tenantId,completedExecution]));
  assert.equal(ledger.rowCount,3);assert.equal(new Set(ledger.rows.map(r=>r.evidence_record_id)).size,2);
  const billing=await withTenantTransaction(pool,tenantId,'kavaroutes_api',db=>db.query('SELECT * FROM billing.billing_case WHERE tenant_id=$1',[tenantId]));assert.equal(billing.rowCount,0,'service proof and completion never create billing readiness');
  assert.equal((await withTenantTransaction(pool,syntheticIds.organizationB,'kavaroutes_api',db=>db.query('SELECT * FROM execution.driver_service_proof'))).rowCount,0);
  await assert.rejects(()=>pool.query('DELETE FROM execution.driver_service_proof WHERE tenant_id=$1',[tenantId]),e=>e.code==='23514');
  // Missing explicit rules fail closed, even with disabled vehicle controls.
  const missing=await freshLeg(null);await action(missing,'MARK_EN_ROUTE');await action(missing,'ARRIVE_PICKUP');await action(missing,'VERIFY_RIDER',{verificationMethod:'NAME_CONFIRMED_WITH_RIDER'},'PROOF_POLICY_REQUIRED');
  const absent=await freshLeg();await action(absent,'MARK_EN_ROUTE');await action(absent,'ARRIVE_PICKUP');
  await action(absent,'REQUEST_CANCEL_LEG',{reason:'RIDER_REQUESTED'});assert.equal((await read(absent)).execution.lifecycle,'ARRIVED_PICKUP','cancel request is not authoritative cancellation');
  await action(absent,'MARK_RIDER_NO_SHOW',{contactAttestation:'ATTEMPTED_NO_RESPONSE',authorizationReference:rule.noShowAuthorizationReference},'NO_SHOW_POLICY_EVIDENCE_REQUIRED');advanceClock();
  await action(absent,'MARK_RIDER_NO_SHOW',{contactAttestation:'ATTEMPTED_NO_RESPONSE',authorizationReference:rule.noShowAuthorizationReference});assert.equal((await read(absent)).execution.lifecycle,'RIDER_NO_SHOW');
  const incident=await freshLeg();await action(incident,'MARK_EN_ROUTE');await action(incident,'ARRIVE_PICKUP');await action(incident,'VERIFY_RIDER',{verificationMethod:'NAME_CONFIRMED_WITH_RIDER'});await action(incident,'SECURE_RIDER',{occupantRestraint:'SECURED',mobilityDevice:'SECURED'});
  const incidentProof=await signature(incident,await makeSignature(incident,'PICKUP_ATTESTATION',17));assert.equal(incidentProof.statusCode,200,incidentProof.body);await action(incident,'BOARD_RIDER');
  await action(incident,'REPORT_INCIDENT',{incidentKind:'VEHICLE_FAILURE',note:'Synthetic onboard vehicle failure'});assert.equal((await read(incident)).execution.lifecycle,'INTERRUPTED');
  const cases=await withTenantTransaction(pool,tenantId,'kavaroutes_api',db=>db.query("SELECT * FROM execution.driver_recovery_case WHERE tenant_id=$1 AND state='OPEN'",[tenantId]));assert.equal(cases.rowCount,1);
  const invalidations=await withTenantTransaction(pool,tenantId,'kavaroutes_api',db=>db.query("SELECT payload FROM outbox.message WHERE tenant_id=$1 AND event_type='DriverActionRecorded'",[tenantId]));
  assert.ok(invalidations.rowCount>20);assert.ok(invalidations.rows.every(r=>Object.keys(r.payload).sort().join()==='assignmentId,driverId,policyDigest,shiftReference'),'dispatch invalidations contain identifiers, not signatures or incident notes');
}
