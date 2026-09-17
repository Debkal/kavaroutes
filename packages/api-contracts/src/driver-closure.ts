import {randomUUID} from 'node:crypto';
import type {Pool} from 'pg';
import {Type,type Static} from 'typebox';
import {createPostgresPersistence,createShiftClosureReader,PersistenceConflict,withTenantTransaction,type TenantMutationTransaction} from '@kavaroutes/postgres-persistence';
import {authorize,companyBranchScope,companyFleetScope,type SyntheticPrincipal} from './security.js';
import {ProtocolError,requestFingerprint} from './protocol.js';
const id=()=>Type.String({format:'uuid'}),closed={additionalProperties:false};
export const DriverClosureRequestSchema=Type.Object({commandId:id(),shiftGeneration:id(),expectedVersion:Type.Integer({minimum:1}),kind:Type.Union([Type.Literal('SIGN_OFF'),Type.Literal('EMERGENCY_STOP')]),reason:Type.Union([Type.Literal('NORMAL_SIGN_OFF'),Type.Literal('SAFETY'),Type.Literal('PRIVACY'),Type.Literal('DEVICE_PROBLEM'),Type.Literal('OTHER')]),sampleId:Type.Optional(id()),parkedAttestation:Type.Boolean()},{...closed,$id:'DriverClosureRequest'});
export const DriverSyntheticLocationRequestSchema=Type.Object({shiftGeneration:id(),samples:Type.Array(Type.Object({sampleId:id(),sequence:Type.Integer({minimum:1}),fixture:Type.Union([Type.Literal('AT_RETURN'),Type.Literal('OUTSIDE_RETURN'),Type.Literal('INACCURATE')]),capturedAt:Type.String({format:'date-time'})},closed),{minItems:1,maxItems:500})},{...closed,$id:'DriverSyntheticLocationRequest'});
export const DriverReturnOverrideRequestSchema=Type.Object({commandId:id(),shiftGeneration:id(),expectedVersion:Type.Integer({minimum:1}),exceptionCommandId:id(),
 // The wire form stays one reason plus an optional flag, so the accepted baseline sees
 // an optional addition rather than a closed-enum change. The flag means: resolve a
 // recorded emergency stop and end the shift although riders are unresolved
 // (audit WEB-A-028); that closure is stored with reason EMERGENCY_STOP_RESOLVED.
 reason:Type.Literal('RETURN_EXCEPTION_REVIEWED'),
 emergencyStopResolution:Type.Optional(Type.Boolean())},{...closed,$id:'DriverReturnOverrideRequest'});
export const DriverReturnReviewSchema=Type.Object({shiftReference:id(),shiftGeneration:id(),resourceVersion:Type.Integer({minimum:1}),exceptionCommandId:Type.Union([id(),Type.Null()]),lifecycle:Type.String({enum:['ACTIVE','SHIFT_ENDED','INVALIDATE_REVIEW']}),returnMode:Type.String({enum:['DISABLED','ADVISORY','REQUIRED_WITH_AUDITED_OVERRIDE']}),returnResult:Type.Union([Type.String({enum:['NOT_REQUIRED','PASS','OUTSIDE','STALE','INACCURATE','UNAVAILABLE','OVERRIDDEN']}),Type.Null()]),
 // Which recorded closure justifies an override: a return exception, or an emergency
 // stop that dispatch resolves with unresolved riders acknowledged (audit WEB-A-028).
 closurePath:Type.Optional(Type.Union([Type.Literal('RETURN_EXCEPTION'),Type.Literal('EMERGENCY_STOP'),Type.Null()]))},{...closed,$id:'DriverReturnReview'});
export const DriverClosureReceiptSchema=Type.Object({shiftReference:id(),resourceVersion:Type.Integer({minimum:1}),lifecycle:Type.String({enum:['ACTIVE','SHIFT_ENDED']}),collectionStopped:Type.Boolean(),returnResult:Type.String({enum:['NOT_REQUIRED','PASS','OUTSIDE','STALE','INACCURATE','UNAVAILABLE','OVERRIDDEN']}),outcome:Type.String({enum:['EMERGENCY_STOP_RECORDED','SHIFT_ENDED','RETURN_REVIEW_REQUIRED']})},{...closed,$id:'DriverClosureReceipt'});
export const DriverSyntheticLocationReceiptSchema=Type.Object({items:Type.Array(Type.Object({sampleId:id(),outcome:Type.String({enum:['APPLIED','REPLAYED','REJECTED']}),code:Type.String({enum:['SYNTHETIC_SAMPLE_SAVED','SAMPLE_OUTSIDE_RETENTION']})},closed),{maxItems:500})},{...closed,$id:'DriverSyntheticLocationReceipt'});
const nullable=(schema:ReturnType<typeof Type.String>)=>Type.Union([schema,Type.Null()]);
export const DriverClosureViewSchema=Type.Object({driverId:id(),shiftReference:id(),shiftGeneration:id(),resourceVersion:Type.Integer({minimum:1}),lifecycle:Type.String(),collectionStopped:Type.Boolean(),returnMode:Type.String(),
 postcheck:Type.Union([Type.Null(),Type.Object({inspectionOutcome:Type.String(),odometerOutcome:Type.String(),odometer:Type.Union([Type.Integer(),Type.Null()]),fuelLevel:nullable(Type.String()),vehicleState:Type.String(),resourceVersion:Type.Integer()},closed)]),
 sample:Type.Union([Type.Null(),Type.Object({sampleId:id(),sequence:Type.Integer(),fixture:Type.String(),capturedAt:Type.String(),fresh:Type.Boolean()},closed)]),lastEvent:nullable(Type.String()),returnResult:nullable(Type.String()),
 tracking:Type.Object({status:Type.String({enum:['SHIFT_ENDED','STATUS_UNAVAILABLE','TRACKING_STOPPED','NO_UPDATES','WAITING_FOR_FIRST_UPDATE','UPDATES_OVERDUE','UPDATES_CURRENT']}),reason:Type.String(),contactDriver:Type.Boolean(),evaluatedAt:Type.String(),lastCapturedAt:nullable(Type.String()),lastReceivedAt:nullable(Type.String()),staleAfterSeconds:Type.Literal(60)},closed)
},{...closed,$id:'DriverClosureView'});
type Base={organizationId:string;principal:SyntheticPrincipal;shiftId:string;key:string};
export function createPostgresDriverClosureService(pool:Pool){
 const db=createPostgresPersistence(pool),reader=createShiftClosureReader(pool);
 const access=(i:Pick<Base,'principal'|'organizationId'>,dispatcher=false)=>authorize(i.principal,i.organizationId,dispatcher?{capability:'dispatch:location:read',purpose:'ASSIGNED_SERVICE_DELIVERY',branchScope:companyBranchScope(i.organizationId),fleetScope:companyFleetScope(i.organizationId)}:{capability:'driver:execute',purpose:'ASSIGNED_SERVICE_DELIVERY'});
 async function publish(tx:TenantMutationTransaction,input:Base,version:number,kind:string,shift:{assignmentId:string;policyDigest:string}){
  await tx.appendAudit({auditId:randomUUID(),aggregateKind:'driver-shift',aggregateId:input.shiftId,aggregateVersion:version,actionReference:kind,actorReference:input.principal.id});
  const now=new Date(),retainUntil=new Date(Date.now()+2_592_100_000),messageId=randomUUID();
  await tx.appendOutboxMessage({messageId,eventId:randomUUID(),aggregateType:'DRIVER_SHIFT',aggregateId:input.shiftId,aggregateVersion:version,eventType:'DriverShiftClosureRecorded',schemaVersion:'v1',occurredAt:now,commandId:randomUUID(),idempotencyReferenceHash:requestFingerprint({key:input.key}),correlationId:randomUUID(),source:'kavaroutes.api',classificationReference:'OPERATIONAL_SENSITIVE',purposeReference:'ASSIGNED_SERVICE_DELIVERY',policyReference:'privacy-synthetic-v1',payload:{shiftReference:input.shiftId,driverId:input.principal.subjectId!,assignmentId:shift.assignmentId,policyDigest:shift.policyDigest},retainUntil});
  await tx.appendOutboxDelivery({deliveryId:randomUUID(),messageId,route:'realtime-signal',jobType:'kr.realtime-signal.driver-shift.v1',availableAt:now,retainUntil});
 }
 return {
  async review(input:Pick<Base,'organizationId'|'principal'|'shiftId'>){
   authorize(input.principal,input.organizationId,{capability:'driver-policy:override',purpose:'ASSIGNED_SERVICE_DELIVERY',branchScope:companyBranchScope(input.organizationId),fleetScope:companyFleetScope(input.organizationId)});
   return withTenantTransaction(pool,input.organizationId,'kavaroutes_api',async client=>{
    const row=(await client.query(`SELECT s.driver_id,s.shift_generation,s.aggregate_version,s.lifecycle,s.effective_policy,s.collection_stopped,c.command_id,c.return_result,c.kind AS closure_kind
     FROM execution.shift_policy_snapshot s LEFT JOIN LATERAL(SELECT command_id,return_result,kind FROM execution.driver_shift_closure
      WHERE tenant_id=s.tenant_id AND shift_id=s.id AND kind IN('RETURN_EXCEPTION','EMERGENCY_STOP')
      ORDER BY CASE kind WHEN 'RETURN_EXCEPTION' THEN 0 ELSE 1 END, aggregate_version DESC LIMIT 1)c ON true WHERE s.tenant_id=$1 AND s.id=$2`,[input.organizationId,input.shiftId])).rows[0];
    if(!row||row.driver_id===input.principal.subjectId)throw new ProtocolError(404,'RESOURCE_NOT_FOUND','separate reviewer required');
    return {shiftReference:input.shiftId,shiftGeneration:String(row.shift_generation),resourceVersion:Number(row.aggregate_version),exceptionCommandId:row.command_id??null,lifecycle:String(row.lifecycle),returnMode:String(row.effective_policy.returnVerification.mode),returnResult:row.return_result??null,
     closurePath:row.closure_kind==='EMERGENCY_STOP'&&row.collection_stopped?'EMERGENCY_STOP':row.closure_kind==='RETURN_EXCEPTION'?'RETURN_EXCEPTION':null};
   },'serializable');
  },
  async override(input:Base&{request:Static<typeof DriverReturnOverrideRequestSchema>}){
   authorize(input.principal,input.organizationId,{capability:'driver-policy:override',purpose:'ASSIGNED_SERVICE_DELIVERY',branchScope:companyBranchScope(input.organizationId),fleetScope:companyFleetScope(input.organizationId)});
   const view=await reader(input.organizationId,input.shiftId);if(!view||view.driverId===input.principal.subjectId)throw new ProtocolError(404,'RESOURCE_NOT_FOUND','separate authorized reviewer required');
   const req=input.request;
   return db.executeIdempotentMutation({tenantId:input.organizationId,actorReference:input.principal.id,operationId:'overrideDriverReturn',key:input.key,fingerprint:requestFingerprint({shift:input.shiftId,request:req}),recordId:randomUUID(),expiresAt:new Date(Date.now()+86_700_000),isolationLevel:'serializable'},async tx=>{
    const shift=await tx.lockDriverActionShift({shiftId:input.shiftId,driverId:view.driverId});if(!shift||shift.lifecycle!=='ACTIVE'||shift.shiftGeneration!==req.shiftGeneration)throw new ProtocolError(404,'RESOURCE_NOT_FOUND','shift hidden');
    if(shift.version!==req.expectedVersion)throw new PersistenceConflict('stale-version','refresh shift');
    const unresolvedRiders=await tx.hasUnfinishedDriverLegs(input.shiftId);
    if(unresolvedRiders){
     // The safety rule stands for an ordinary override. An emergency-stopped shift is
     // the exception: tracking is already stopped, the driver cannot sign off, so the
     // reviewer ends it and the acknowledgement is recorded (audit WEB-A-028).
     if(req.emergencyStopResolution!==true)throw new ProtocolError(409,'UNFINISHED_SHIFT_WORK','override never waives unresolved riders');
     if(view.lastEvent!=='EMERGENCY_STOP'||!view.collectionStopped)throw new ProtocolError(409,'EMERGENCY_STOP_REQUIRED','only an emergency-stopped shift can end with unresolved riders');
    }
    const policy=shift.effectivePolicy as unknown as {postInspection:{mode:string};endOdometer:{mode:string};returnVerification:{mode:string}};
    if(policy.returnVerification.mode!=='REQUIRED_WITH_AUDITED_OVERRIDE')throw new ProtocolError(409,'RETURN_OVERRIDE_NOT_REQUIRED','override unavailable');
    const post=await tx.readDriverPrecheck(input.shiftId,'POST');
    const emergencyResolution=req.emergencyStopResolution===true&&unresolvedRiders;
    if(!emergencyResolution)for(const[mode,outcome]of [[policy.postInspection.mode,post?.inspectionOutcome],[policy.endOdometer.mode,post?.odometerOutcome]])if(mode==='REQUIRED'&&outcome!=='COMPLETED'||mode==='OPTIONAL'&&!['COMPLETED','SKIPPED'].includes(outcome??''))throw new ProtocolError(409,'POSTCHECK_DECISION_REQUIRED','override cannot waive postcheck');
    // The cited closure row is the recorded exception (ordinary override) or the
    // recorded emergency stop (resolution), and the reason says which one.
    const body=await tx.closeDriverShift({shiftId:input.shiftId,commandId:req.commandId,actorId:input.principal.id,kind:'DISPATCH_OVERRIDE',reason:emergencyResolution?'EMERGENCY_STOP_RESOLVED':'RETURN_EXCEPTION_REVIEWED',evidenceReference:req.exceptionCommandId});
    await publish(tx,{...input,principal:{...input.principal,subjectId:view.driverId}},body.resourceVersion,
      emergencyResolution?'driver.shift.emergency_stop_resolved':'driver.return.override_ended_shift',shift);
    return {statusCode:200,body,headers:{},resultReference:input.shiftId};
   });
  },
  async read(input:Omit<Base,'key'>&{dispatcher:boolean}){access(input,input.dispatcher);const view=await reader(input.organizationId,input.shiftId);if(!view||!input.dispatcher&&view.driverId!==input.principal.subjectId)throw new ProtocolError(404,'RESOURCE_NOT_FOUND','shift hidden');return view;},
  async locations(input:Base&{request:Static<typeof DriverSyntheticLocationRequestSchema>}){
   access(input);authorize(input.principal,input.organizationId,{capability:'driver:location:write',purpose:'ASSIGNED_SERVICE_DELIVERY'});if(!input.principal.subjectId)throw new ProtocolError(404,'RESOURCE_NOT_FOUND','driver required');
   return db.executeIdempotentMutation({tenantId:input.organizationId,actorReference:input.principal.id,operationId:'submitDriverSyntheticLocations',key:input.key,fingerprint:requestFingerprint({shift:input.shiftId,request:input.request}),recordId:randomUUID(),expiresAt:new Date(Date.now()+86_700_000),isolationLevel:'serializable'},async tx=>{
    const shift=await tx.lockDriverActionShift({shiftId:input.shiftId,driverId:input.principal.subjectId!});if(!shift||shift.lifecycle!=='ACTIVE')throw new ProtocolError(404,'RESOURCE_NOT_FOUND','shift hidden');
    const items=await tx.recordSyntheticLocations({shiftId:input.shiftId,generation:input.request.shiftGeneration,samples:input.request.samples});return {statusCode:200,body:{items},headers:{},resultReference:input.shiftId};
   });
  },
  async close(input:Base&{request:Static<typeof DriverClosureRequestSchema>}){
   access(input);if(!input.principal.subjectId)throw new ProtocolError(404,'RESOURCE_NOT_FOUND','driver required');
   const req=input.request,emergency=req.kind==='EMERGENCY_STOP';
   if(emergency?req.reason==='NORMAL_SIGN_OFF':req.reason!=='NORMAL_SIGN_OFF'||!req.parkedAttestation)throw new ProtocolError(422,'CLOSURE_REASON_INVALID','invalid closure');
   return db.executeIdempotentMutation({tenantId:input.organizationId,actorReference:input.principal.id,operationId:'closeDriverShift',key:input.key,fingerprint:requestFingerprint({shift:input.shiftId,request:req}),recordId:randomUUID(),expiresAt:new Date(Date.now()+86_700_000),isolationLevel:'serializable'},async tx=>{
    const shift=await tx.lockDriverActionShift({shiftId:input.shiftId,driverId:input.principal.subjectId!});if(!shift||shift.shiftGeneration!==req.shiftGeneration||shift.lifecycle!=='ACTIVE')throw new ProtocolError(404,'RESOURCE_NOT_FOUND','shift hidden');
    if(!emergency&&shift.version!==req.expectedVersion)throw new PersistenceConflict('stale-version','refresh shift');
    if(!emergency){
     if(await tx.hasUnfinishedDriverLegs(input.shiftId))throw new ProtocolError(409,'UNFINISHED_SHIFT_WORK','resolve work first');
     const policy=shift.effectivePolicy as unknown as {postInspection:{mode:string};endOdometer:{mode:string}};
     const post=await tx.readDriverPrecheck(input.shiftId,'POST');
     for(const [mode,outcome]of [[policy.postInspection.mode,post?.inspectionOutcome],[policy.endOdometer.mode,post?.odometerOutcome]]){
      if(!['DISABLED','OPTIONAL','REQUIRED'].includes(mode!)||mode==='REQUIRED'&&outcome!=='COMPLETED'||mode==='OPTIONAL'&&!['COMPLETED','SKIPPED'].includes(outcome??''))throw new ProtocolError(409,'POSTCHECK_DECISION_REQUIRED','postcheck required');
     }
    }
    const body=await tx.closeDriverShift({shiftId:input.shiftId,commandId:req.commandId,actorId:input.principal.id,kind:req.kind,reason:req.reason,...(req.sampleId?{sampleId:req.sampleId}:{})});
    await publish(tx,input,body.resourceVersion,emergency?'driver.tracking.emergency_stopped':body.lifecycle==='SHIFT_ENDED'?'driver.shift.ended':'driver.return.exception',shift);
    return {statusCode:200,body,headers:{},resultReference:input.shiftId};
   });
  }
 };
}
export type DriverClosureService=ReturnType<typeof createPostgresDriverClosureService>;
