import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {createCloudDriverApi} from '../../../apps/driver/src/cloud-server.ts';
import {createCloudCommandStore} from '../../../apps/driver/src/cloud-command-store.ts';
import {createCloudPrecheckStore} from '../../../apps/driver/src/cloud-precheck-store.ts';
import {createCloudFinishStore} from '../../../apps/driver/src/cloud-finish-store.ts';
import {recoverCloudFinish} from '../../../apps/driver/src/cloud-finish.ts';
import {DRIVER_MIGRATIONS} from '../../../packages/driver-core/dist/index.js';
import {precheckItems} from '../../../packages/api-contracts/dist/index.js';
if(process.env.KAVAROUTES_VERIFY_PRIVATE_CLOUD!=='1'||!['sample','overdue','finish','verify'].includes(process.argv[2]))throw new Error('EXPLICIT_SOL007_PHASE_REQUIRED');
const phase=process.argv[2],base='http://127.0.0.1:58080',prefix='/v1/organizations/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const shift='c2e88496-5850-408a-af3b-fa868bb6ae83',assignment='42000000-0000-4000-8000-000000000001';
// Existing, already verified completed SOL-004 workflow; never create a replacement shift.
const path='.tooling/gcp/sol004-client-recovery.sqlite';let db=new DatabaseSync(path,{open:true}),tail=Promise.resolve();
const adapter={getFirstAsync:async(sql,...p)=>db.prepare(sql).get(...p)??null,getAllAsync:async(sql,...p)=>db.prepare(sql).all(...p),runAsync:async(sql,...p)=>db.prepare(sql).run(...p),withExclusiveTransactionAsync:fn=>{const call=tail.then(async()=>{db.exec('BEGIN');try{await fn(adapter);db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e;}});tail=call.catch(()=>{});return call;}};
for(const m of DRIVER_MIGRATIONS)if(!db.prepare('SELECT 1 FROM smoke_migration WHERE version=?').get(m.version)){db.exec('BEGIN');try{db.exec(m.sql);db.prepare('INSERT INTO smoke_migration VALUES(?)').run(m.version);db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e;}}
const api=createCloudDriverApi({baseUrl:base,fetch}),commands=createCloudCommandStore(adapter,{uuid:randomUUID,now:()=>new Date().toISOString()}),finish=createCloudFinishStore(adapter,randomUUID),post=createCloudPrecheckStore(adapter,{newKey:randomUUID,now:()=>new Date().toISOString(),stage:'POST'});
const reopen=()=>{db.close();db=new DatabaseSync(path);};
async function dispatchStatus(){const r=await fetch(`${base}${prefix}/dispatch/shifts/${shift}/status`,{headers:{authorization:'Synthetic principal_dispatcher'}});assert.equal(r.status,200);return r.json();}
try{
 const original=await commands.start();assert.equal(original?.receipt?.shiftReference,shift);
 const before=(await api.getClosure(shift)).value;
 if(phase==='sample'){
  assert.equal(before.lifecycle,'ACTIVE');assert.equal(before.collectionStopped,false);
  const command=await finish.prepare(shift,'LOCATION',{shiftGeneration:before.shiftGeneration,samples:[{sampleId:randomUUID(),sequence:(before.sample?.sequence??0)+1,fixture:'OUTSIDE_RETURN',capturedAt:new Date().toISOString()}]});
  await api.submitSyntheticLocations(shift,command.request,command.key);reopen();
  assert.equal((await finish.list(shift)).find(c=>c.key===command.key).state,'PENDING');
  await recoverCloudFinish(api,finish,shift,async()=>{});
  assert.equal((await dispatchStatus()).tracking.status,'UPDATES_CURRENT');
  console.log('SOL007_CLOUD_SAMPLE_REPLAY_AND_DISPATCH_CURRENT_VERIFIED');
 }else if(phase==='overdue'){
  const status=await dispatchStatus();assert.equal(status.tracking.status,'UPDATES_OVERDUE');assert.equal(status.tracking.contactDriver,true);assert.equal(status.tracking.reason,'NO_RECENT_UPDATE_UNKNOWN_CAUSE');
  console.log('SOL007_CLOUD_SILENCE_CONTACT_DRIVER_VERIFIED');
 }else if(phase==='finish'){
  if(before.lifecycle==='SHIFT_ENDED'){console.log('SOL007_SHIFT_ALREADY_ENDED_NO_NEW_COMMAND');}
  else{
   const state=(await api.getShift(assignment)).value;
   const itinerary=(await api.getItinerary('2026-09-14')).value,legs=itinerary.legs.filter(l=>l.assignmentId===assignment);
   assert.ok(legs.length&&legs.every(l=>['COMPLETED','RIDER_NO_SHOW','CANCELLED'].includes(l.execution?.lifecycle)));
   if(!before.postcheck){
    const saved=await post.prepare(shift,{shiftGeneration:before.shiftGeneration,vehicleId:legs[0].vehicleId,policyDigest:state.effectivePolicy.canonicalDigest,expectedVersion:before.resourceVersion,capturedAt:new Date().toISOString(),photos:[],inspection:{decision:'COMPLETED',definitionVersion:'inspection-synthetic-v2',entries:precheckItems.map(item=>({item,response:'NO_DEFECT'}))},odometer:{decision:'COMPLETED',value:10430,fuelLevel:'FULL'}});
    await api.submitPostcheck(shift,saved.request,saved.key);reopen();
    const pending=await post.read(shift);await post.record(shift,pending.key,(await api.submitPostcheck(shift,pending.request,pending.key)).value);
   }
   const ready=(await api.getClosure(shift)).value;
   const command=await finish.prepare(shift,'CLOSE',{commandId:randomUUID(),shiftGeneration:ready.shiftGeneration,expectedVersion:ready.resourceVersion,kind:'SIGN_OFF',reason:'NORMAL_SIGN_OFF',parkedAttestation:true});
   await api.submitClosure(shift,command.request,command.key);reopen();
   const result=await recoverCloudFinish(api,finish,shift,async()=>{});
   assert.ok(result.lifecycle==='SHIFT_ENDED'||result.lastEvent==='RETURN_EXCEPTION');
   console.log(JSON.stringify({result:'SOL007_POSTCHECK_CLOSE_REPLAY_VERIFIED',lifecycle:result.lifecycle,returnResult:result.returnResult,next:result.lifecycle==='SHIFT_ENDED'?'verify':'authorized_browser_return_review'}));
  }
 }else{
  assert.equal(before.lifecycle,'SHIFT_ENDED');assert.equal(before.collectionStopped,true);
  const status=await dispatchStatus();assert.equal(status.tracking.status,'SHIFT_ENDED');assert.equal(status.tracking.contactDriver,false);
  console.log('SOL007_CLOUD_ACCEPTED_END_AND_DISPATCH_STOP_VERIFIED');
 }
}finally{db.close();}
