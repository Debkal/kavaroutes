import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {verifyRecoveryCommand} from './browser-recovery-api.mjs';
import {createPostgresDriverClosureService,createSyntheticTestVerifier,createWp007Api} from '../../dist/index.js';
import {reconcileTrackingAlerts} from '../../../postgres-persistence/dist/index.js';
import {resolveEffectiveDriverPolicy} from '../../../platform-engine/dist/domain/index.js';
export async function verifyDriverClosure(pool,tenantId,fixture,runtimeApp){
 const base=await createSyntheticTestVerifier().verify('Synthetic principal_driver'),principal={...base,subjectId:fixture.driverId};
 const service=createPostgresDriverClosureService(pool),verifier=createSyntheticTestVerifier();
 const app=runtimeApp??await createWp007Api({driverClosureService:service,verifier:{verify:async v=>v==='Synthetic principal_driver'?principal:verifier.verify(v)}});
 const prefix=`/v1/organizations/${tenantId}`,url=`${prefix}/driver/shifts/${fixture.shiftId}`,headers={authorization:'Synthetic principal_driver'};
 try{
  const response=await app.inject({url:`${url}/status`,headers});assert.equal(response.statusCode,200,response.body);const state=response.json();
  assert.equal((await app.inject({url:`${url}/status`,headers:{authorization:'Synthetic principal_facility'}})).statusCode,404);
  const request={commandId:randomUUID(),shiftGeneration:state.shiftGeneration,expectedVersion:state.resourceVersion,kind:'SIGN_OFF',reason:'NORMAL_SIGN_OFF',parkedAttestation:true};
  const send=req=>app.inject({method:'POST',url:`${url}/commands/close`,headers:{...headers,'idempotency-key':req.commandId},payload:req});
  const blocked=await send(request);assert.equal(blocked.statusCode,200,blocked.body);assert.equal(blocked.json().outcome,'RETURN_REVIEW_REQUIRED');assert.equal(blocked.json().collectionStopped,false);
  assert.deepEqual((await send(request)).json(),blocked.json());
  const overrideUrl=`${prefix}/dispatch/shifts/${fixture.shiftId}/commands/override-return`;
  const overrideRequest={commandId:randomUUID(),shiftGeneration:state.shiftGeneration,expectedVersion:blocked.json().resourceVersion,exceptionCommandId:request.commandId,reason:'RETURN_EXCEPTION_REVIEWED'};
  const reviewUrl=`${prefix}/dispatch/shifts/${fixture.shiftId}/return-review`;
  for(const persona of ['principal_driver','principal_dispatcher','principal_facility']){
   assert.equal((await app.inject({url:reviewUrl,headers:{authorization:`Synthetic ${persona}`}})).statusCode,404);
   const denied=await app.inject({method:'POST',url:overrideUrl,headers:{authorization:`Synthetic ${persona}`,'idempotency-key':randomUUID()},payload:overrideRequest});assert.equal(denied.statusCode,404,denied.body);
  }
  const review=await app.inject({url:reviewUrl,headers:{authorization:'Synthetic principal_policy_override'}});assert.equal(review.statusCode,200,review.body);assert.equal(review.json().exceptionCommandId,request.commandId);assert.deepEqual(Object.keys(review.json()).sort(),['exceptionCommandId','lifecycle','resourceVersion','returnMode','returnResult','shiftGeneration','shiftReference']);
  const wrongEvidence=await app.inject({method:'POST',url:overrideUrl,headers:{authorization:'Synthetic principal_policy_override','idempotency-key':randomUUID()},payload:{...overrideRequest,exceptionCommandId:randomUUID()}});assert.equal(wrongEvidence.statusCode,404,wrongEvidence.body);
  await pool.query("INSERT INTO execution.driver_return_configuration VALUES($1,$2,1,'AT_RETURN',60)",[tenantId,fixture.shiftId]);
  const sample={sampleId:randomUUID(),sequence:1,fixture:'AT_RETURN',capturedAt:new Date().toISOString()};
  const batch={method:'POST',url:`${url}/synthetic-location-batches`,headers:{...headers,'idempotency-key':randomUUID()},payload:{shiftGeneration:state.shiftGeneration,samples:[sample]}};
  const saved=await app.inject(batch);assert.equal(saved.statusCode,200,saved.body);assert.equal(saved.json().items[0].outcome,'APPLIED');assert.deepEqual((await app.inject(batch)).json(),saved.json());
  const old=await app.inject({...batch,headers:{...headers,'idempotency-key':randomUUID()},payload:{shiftGeneration:state.shiftGeneration,samples:[{...sample,sampleId:randomUUID(),sequence:2,capturedAt:new Date(Date.now()-3600000).toISOString()}]}});assert.equal(old.statusCode,200,old.body);assert.equal(old.json().items[0].outcome,'REJECTED');
  const position=await app.inject({url:`${prefix}/dispatch/shifts/${fixture.shiftId}/status`,headers:{authorization:'Synthetic principal_dispatcher'}});assert.equal(position.statusCode,200,position.body);assert.equal(position.json().tracking.status,'UPDATES_CURRENT');
  await reconcileTrackingAlerts(pool,tenantId);
  const before=Number((await pool.query('SELECT count(*) FROM execution.driver_tracking_alert_event WHERE tenant_id=$1 AND shift_id=$2',[tenantId,fixture.shiftId])).rows[0].count);
  const later=new Date(Date.now()+61000);await reconcileTrackingAlerts(pool,tenantId,later);await reconcileTrackingAlerts(pool,tenantId,later);
  assert.equal(Number((await pool.query('SELECT count(*) FROM execution.driver_tracking_alert_event WHERE tenant_id=$1 AND shift_id=$2',[tenantId,fixture.shiftId])).rows[0].count),before+1,'silence produces one durable transition, not repeated alerts');
  assert.equal((await pool.query('SELECT status FROM execution.driver_tracking_alert WHERE tenant_id=$1 AND shift_id=$2',[tenantId,fixture.shiftId])).rows[0].status,'UPDATES_OVERDUE');
  await reconcileTrackingAlerts(pool,tenantId);assert.equal((await pool.query('SELECT status FROM execution.driver_tracking_alert WHERE tenant_id=$1 AND shift_id=$2',[tenantId,fixture.shiftId])).rows[0].status,'UPDATES_CURRENT');
  await assert.rejects(()=>pool.query('DELETE FROM execution.driver_tracking_alert_event WHERE tenant_id=$1 AND shift_id=$2',[tenantId,fixture.shiftId]),e=>e.code==='23514');
  const done=await send({...request,commandId:randomUUID(),expectedVersion:blocked.json().resourceVersion,sampleId:sample.sampleId});assert.equal(done.statusCode,200,done.body);assert.equal(done.json().lifecycle,'SHIFT_ENDED');assert.equal(done.json().collectionStopped,true);
  const closed=await app.inject({url:`${url}/status`,headers});assert.equal(closed.json().tracking.status,'SHIFT_ENDED');assert.equal(closed.json().tracking.contactDriver,false);
  const after=await app.inject({...batch,headers:{...headers,'idempotency-key':randomUUID()},payload:{shiftGeneration:state.shiftGeneration,samples:[{...sample,sampleId:randomUUID(),sequence:3}]}});assert.notEqual(after.statusCode,200,'stopped generation rejects new location writes');
  // Disposable policy fixtures only: exercise independent closure policies, not real shift-start acceptance.
  const binding=(await pool.query('SELECT assignment_id,pinned_assignment_version FROM execution.shift_policy_snapshot WHERE tenant_id=$1 AND id=$2',[tenantId,fixture.shiftId])).rows[0];
  for(const mode of ['DISABLED','ADVISORY','REQUIRED_WITH_AUDITED_OVERRIDE']){
   const shiftId=randomUUID(),generation=randomUUID();
   const policy=resolveEffectiveDriverPolicy({organizationId:tenantId,driverId:fixture.driverId,assignmentId:binding.assignment_id,commercialTier:'SMALL_BUSINESS',workforceRelationship:'OWNER_OPERATOR',policyVersion:1,resolvedAt:new Date().toISOString(),organization:{postInspection:{mode:'DISABLED',locked:false},endOdometer:{mode:'DISABLED',locked:false},returnVerification:{mode,locked:false}},capabilities:new Set()});
   await pool.query('INSERT INTO execution.shift_policy_snapshot(tenant_id,id,assignment_id,driver_id,shift_generation,policy_version,policy_digest,effective_policy,pinned_assignment_version) VALUES($1,$2,$3,$4,$5,1,$6,$7::jsonb,$8)',[tenantId,shiftId,binding.assignment_id,fixture.driverId,generation,policy.canonicalDigest,JSON.stringify(policy),binding.pinned_assignment_version]);
   const endpoint=`${prefix}/driver/shifts/${shiftId}`,close=req=>app.inject({method:'POST',url:`${endpoint}/commands/close`,headers:{...headers,'idempotency-key':req.commandId},payload:req});
   const req={...request,commandId:randomUUID(),shiftGeneration:generation,expectedVersion:1};
   const wrong=await close({...req,commandId:randomUUID(),shiftGeneration:randomUUID()});assert.equal(wrong.statusCode,404,wrong.body);
   const result=await close(req);assert.equal(result.statusCode,200,result.body);
   if(mode!=='REQUIRED_WITH_AUDITED_OVERRIDE'){
    assert.equal(result.json().lifecycle,'SHIFT_ENDED');assert.equal(result.json().returnResult,mode==='DISABLED'?'NOT_REQUIRED':'UNAVAILABLE');
   }else{
    assert.equal(result.json().outcome,'RETURN_REVIEW_REQUIRED');
    // Emergency stop cannot be blocked by a stale application version or absence of return GPS.
    const emergency={...req,commandId:randomUUID(),expectedVersion:999,kind:'EMERGENCY_STOP',reason:'OTHER',parkedAttestation:false};
    const stopped=await close(emergency);assert.equal(stopped.statusCode,200,stopped.body);assert.equal(stopped.json().collectionStopped,true);assert.equal(stopped.json().lifecycle,'ACTIVE');
    assert.deepEqual((await close(emergency)).json(),stopped.json());
    const stoppedRead=await app.inject({url:`${endpoint}/status`,headers});assert.equal(stoppedRead.json().tracking.reason,'DRIVER_REPORTED_OTHER');assert.equal(stoppedRead.json().tracking.contactDriver,true);
    const recoveryId=randomUUID();
    const approvedRequest={method:'POST',url:`${prefix}/dispatch/shifts/${shiftId}/commands/override-return`,headers:{authorization:'Synthetic principal_policy_override','idempotency-key':`browser-command-${recoveryId}`},payload:{commandId:randomUUID(),shiftGeneration:generation,expectedVersion:stopped.json().resourceVersion,exceptionCommandId:req.commandId,reason:'RETURN_EXCEPTION_REVIEWED'}};
    if(runtimeApp)await verifyRecoveryCommand(app,tenantId,recoveryId,{kind:'OVERRIDE_RETURN',resourceId:shiftId,body:approvedRequest.payload},'principal_policy_override');
    const approved=await app.inject(approvedRequest);assert.equal(approved.statusCode,200,approved.body);assert.equal(approved.json().lifecycle,'SHIFT_ENDED');assert.equal(approved.json().returnResult,'OVERRIDDEN');assert.deepEqual((await app.inject(approvedRequest)).json(),approved.json());
   }
  }
 }finally{if(!runtimeApp)await app.close();}
}
