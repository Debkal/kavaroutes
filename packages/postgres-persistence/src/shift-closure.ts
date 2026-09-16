import type {Pool,PoolClient} from 'pg';
import {PersistenceConflict,withTenantTransaction} from './repositories.js';
import {evaluateSyntheticReturn,assessTrackingFreshness} from '@kavaroutes/platform-engine/domain';
export type SyntheticLocationInput={shiftId:string;generation:string;samples:readonly {sampleId:string;sequence:number;fixture:'AT_RETURN'|'OUTSIDE_RETURN'|'INACCURATE';capturedAt:string}[]};
export type ShiftClosureInput={shiftId:string;commandId:string;actorId:string;kind:'SIGN_OFF'|'EMERGENCY_STOP'|'DISPATCH_OVERRIDE';reason:'NORMAL_SIGN_OFF'|'SAFETY'|'PRIVACY'|'DEVICE_PROBLEM'|'OTHER'|'RETURN_EXCEPTION_REVIEWED';sampleId?:string;evidenceReference?:string};
const conflict=(text:string):never=>{throw new PersistenceConflict('relationship',text);};
export async function recordSyntheticLocations(db:PoolClient,tenantId:string,input:SyntheticLocationInput){
 const shift=(await db.query('SELECT lifecycle,shift_generation,collection_stopped,pinned_at FROM execution.shift_policy_snapshot WHERE tenant_id=$1 AND id=$2 FOR UPDATE',[tenantId,input.shiftId])).rows[0];
 if(!shift||shift.lifecycle!=='ACTIVE'||shift.collection_stopped||shift.shift_generation!==input.generation)conflict('tracking generation closed');
 await db.query('DELETE FROM execution.driver_synthetic_location WHERE tenant_id=$1 AND expires_at<=now()',[tenantId]);
 const now=Date.now(),items:{sampleId:string;outcome:'APPLIED'|'REPLAYED'|'REJECTED';code:string}[]=[];
 for(const s of input.samples){
  const existing=(await db.query('SELECT * FROM execution.driver_synthetic_location WHERE tenant_id=$1 AND (sample_id=$2 OR (shift_id=$3 AND sequence_number=$4))',[tenantId,s.sampleId,input.shiftId,s.sequence])).rows;
  if(existing.length){const r=existing[0];if(existing.length!==1||r.sample_id!==s.sampleId||r.shift_id!==input.shiftId||r.shift_generation!==input.generation||Number(r.sequence_number)!==s.sequence||r.fixture!==s.fixture||new Date(r.captured_at).getTime()!==Date.parse(s.capturedAt))conflict('location identity changed');items.push({sampleId:s.sampleId,outcome:'REPLAYED',code:'SYNTHETIC_SAMPLE_SAVED'});continue;}
  const captured=Date.parse(s.capturedAt);
  if(!Number.isFinite(captured)||captured<new Date(shift.pinned_at).getTime()||captured>now+30000||now-captured>30*60*1000){items.push({sampleId:s.sampleId,outcome:'REJECTED',code:'SAMPLE_OUTSIDE_RETENTION'});continue;}
  await db.query(`INSERT INTO execution.driver_synthetic_location(tenant_id,shift_id,sample_id,shift_generation,sequence_number,fixture,captured_at,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,now()+interval '30 minutes')`,[tenantId,input.shiftId,s.sampleId,input.generation,s.sequence,s.fixture,s.capturedAt]);
  await db.query(`UPDATE execution.shift_policy_snapshot SET last_location_captured_at=$3,last_location_received_at=now()
    WHERE tenant_id=$1 AND id=$2 AND (last_location_captured_at IS NULL OR last_location_captured_at<$3::timestamptz)`,[tenantId,input.shiftId,s.capturedAt]);
  items.push({sampleId:s.sampleId,outcome:'APPLIED',code:'SYNTHETIC_SAMPLE_SAVED'});
 }
 return items;
}
export async function closeDriverShift(db:PoolClient,tenantId:string,input:ShiftClosureInput){
 const s=(await db.query('SELECT * FROM execution.shift_policy_snapshot WHERE tenant_id=$1 AND id=$2 FOR UPDATE',[tenantId,input.shiftId])).rows[0];
 if(!s||s.lifecycle!=='ACTIVE')conflict('shift closure unavailable');
 const emergency=input.kind==='EMERGENCY_STOP',override=input.kind==='DISPATCH_OVERRIDE';
 const mode=s.effective_policy.returnVerification.mode;
 if(mode==='DISABLED'&&input.sampleId)conflict('disabled return cannot collect a return sample');
 if(override&&(!input.evidenceReference||input.reason!=='RETURN_EXCEPTION_REVIEWED'))conflict('override evidence required');
 if(override&&!(await db.query("SELECT 1 FROM execution.driver_shift_closure WHERE tenant_id=$1 AND shift_id=$2 AND command_id=$3 AND kind='RETURN_EXCEPTION'",[tenantId,input.shiftId,input.evidenceReference])).rowCount)conflict('recorded return exception required');
 if(!override&&input.evidenceReference)conflict('driver cannot submit override evidence');
 if(emergency&&input.sampleId)conflict('emergency stop does not require location');
 const config=mode==='DISABLED'||emergency?null:(await db.query('SELECT * FROM execution.driver_return_configuration WHERE tenant_id=$1 AND shift_id=$2',[tenantId,input.shiftId])).rows[0];
 const sample=input.sampleId?(await db.query('SELECT fixture,captured_at FROM execution.driver_synthetic_location WHERE tenant_id=$1 AND shift_id=$2 AND sample_id=$3 AND shift_generation=$4 AND expires_at>now()',[tenantId,input.shiftId,input.sampleId,s.shift_generation])).rows[0]:null;
 const result=emergency?'NOT_REQUIRED':override?'OVERRIDDEN':evaluateSyntheticReturn(mode,sample?{fixture:sample.fixture,capturedAt:new Date(sample.captured_at).getTime()}:null,config?.maximum_age_seconds??null,Date.now());
 const accepted=!emergency&&(override||mode!=='REQUIRED_WITH_AUDITED_OVERRIDE'||result==='PASS');
 const version=Number(s.aggregate_version)+1;
 await db.query(`INSERT INTO execution.driver_shift_closure(tenant_id,shift_id,command_id,aggregate_version,kind,return_result,reason_code,evidence_reference,actor_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[tenantId,input.shiftId,input.commandId,version,accepted||emergency?input.kind:'RETURN_EXCEPTION',result,input.reason,input.evidenceReference??null,input.actorId]);
 await db.query('UPDATE execution.shift_policy_snapshot SET aggregate_version=$3,lifecycle=$4,collection_stopped=$5 WHERE tenant_id=$1 AND id=$2',[tenantId,input.shiftId,version,accepted?'SHIFT_ENDED':'ACTIVE',Boolean(s.collection_stopped)||accepted||emergency]);
 return {shiftReference:input.shiftId,resourceVersion:version,lifecycle:accepted?'SHIFT_ENDED' as const:'ACTIVE' as const,collectionStopped:Boolean(s.collection_stopped)||accepted||emergency,returnResult:result,outcome:emergency?'EMERGENCY_STOP_RECORDED' as const:accepted?'SHIFT_ENDED' as const:'RETURN_REVIEW_REQUIRED' as const};
}
export function createShiftClosureReader(pool:Pool){return async(tenantId:string,shiftId:string)=>withTenantTransaction(pool,tenantId,'kavaroutes_api',async db=>{
 const s=(await db.query('SELECT driver_id,shift_generation,aggregate_version,lifecycle,collection_stopped,effective_policy,pinned_at,last_location_captured_at,last_location_received_at FROM execution.shift_policy_snapshot WHERE tenant_id=$1 AND id=$2',[tenantId,shiftId])).rows[0];if(!s)return null;
 const post=(await db.query('SELECT inspection_outcome,odometer_outcome,odometer,fuel_level,vehicle_state,aggregate_version FROM execution.driver_postcheck_decision WHERE tenant_id=$1 AND shift_id=$2',[tenantId,shiftId])).rows[0];
 const sample=(await db.query('SELECT sample_id,sequence_number,fixture,captured_at FROM execution.driver_synthetic_location WHERE tenant_id=$1 AND shift_id=$2 AND shift_generation=$3 AND expires_at>now() ORDER BY sequence_number DESC LIMIT 1',[tenantId,shiftId,s.shift_generation])).rows[0];
 const latest=(await db.query('SELECT kind,return_result,reason_code FROM execution.driver_shift_closure WHERE tenant_id=$1 AND shift_id=$2 ORDER BY aggregate_version DESC LIMIT 1',[tenantId,shiftId])).rows[0];
 const tracking=assessTrackingFreshness({now:Date.now(),startedAt:new Date(s.pinned_at).getTime(),lifecycle:s.lifecycle,collectionStopped:s.collection_stopped,lastCapturedAt:s.last_location_captured_at?new Date(s.last_location_captured_at).getTime():null,lastReceivedAt:s.last_location_received_at?new Date(s.last_location_received_at).getTime():null,stopReason:latest?.kind==='EMERGENCY_STOP'?latest.reason_code:null});
 return {driverId:String(s.driver_id),shiftReference:shiftId,shiftGeneration:String(s.shift_generation),resourceVersion:Number(s.aggregate_version),lifecycle:String(s.lifecycle),collectionStopped:Boolean(s.collection_stopped),returnMode:String(s.effective_policy.returnVerification.mode),postcheck:post?{inspectionOutcome:post.inspection_outcome,odometerOutcome:post.odometer_outcome,odometer:post.odometer,fuelLevel:post.fuel_level,vehicleState:post.vehicle_state,resourceVersion:Number(post.aggregate_version)}:null,
 tracking,sample:sample?{sampleId:String(sample.sample_id),sequence:Number(sample.sequence_number),fixture:String(sample.fixture),capturedAt:new Date(sample.captured_at).toISOString(),fresh:tracking.status==='UPDATES_CURRENT'}:null,lastEvent:latest?String(latest.kind):null,returnResult:latest?String(latest.return_result):null};
 },'serializable');}
