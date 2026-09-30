import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {mkdir} from 'node:fs/promises';
import {createCloudDriverApi} from '../../../apps/driver/src/cloud-server.ts';
import {createCloudCommandStore} from '../../../apps/driver/src/cloud-command-store.ts';
import {createCloudSignatureStore} from '../../../apps/driver/src/cloud-signature-store.ts';
import {cloudSignatureDigestInput} from '../../../apps/driver/src/cloud-signature.ts';
import {DRIVER_MIGRATIONS} from '../../../packages/driver-core/dist/index.js';
import {precheckItems} from '../../../packages/api-contracts/dist/index.js';
import {setTimeout as delay} from 'node:timers/promises';

if(process.env.KAVAROUTES_VERIFY_PRIVATE_CLOUD!=='1')throw new Error('PRIVATE_CLOUD_OPT_IN_REQUIRED');
const base='http://127.0.0.1:58080',organization='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',date='2026-09-14';
const assignment='42000000-0000-4000-8000-000000000001',legId='32000000-0000-4000-8000-000000000005';
await mkdir('.tooling/gcp',{recursive:true});const path='.tooling/gcp/sol004-client-recovery.sqlite';
let db=new DatabaseSync(path),tail=Promise.resolve();
const adapter={getFirstAsync:async(sql,...p)=>db.prepare(sql).get(...p)??null,getAllAsync:async(sql,...p)=>db.prepare(sql).all(...p),runAsync:async(sql,...p)=>db.prepare(sql).run(...p),
 withExclusiveTransactionAsync:fn=>{const call=tail.then(async()=>{db.exec('BEGIN');try{await fn(adapter);db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e;}});tail=call.catch(()=>{});return call;}};
db.exec('CREATE TABLE IF NOT EXISTS smoke_migration(version INTEGER PRIMARY KEY)');
for(const m of DRIVER_MIGRATIONS)if(!db.prepare('SELECT 1 FROM smoke_migration WHERE version=?').get(m.version)){db.exec('BEGIN');try{db.exec(m.sql);db.prepare('INSERT INTO smoke_migration VALUES(?)').run(m.version);db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e;}}
const stores=()=>({commands:createCloudCommandStore(adapter,{uuid:randomUUID,now:()=>new Date().toISOString()}),proofs:createCloudSignatureStore(adapter,randomUUID)});
let {commands,proofs}=stores();const api=createCloudDriverApi({baseUrl:base,fetch});
const reopen=()=>{db.close();db=new DatabaseSync(path);({commands,proofs}=stores());};
const dispatchHeaders={authorization:'Synthetic principal_dispatcher','content-type':'application/json'};
async function dispatcher(path,body){const r=await fetch(base+path,{method:body?'POST':'GET',headers:dispatchHeaders,...(body?{body:JSON.stringify(body)}:{})});assert.equal(r.status,200);return r.json();}
const prefix=`/v1/organizations/${organization}`;
try {
 await api.authenticate();let itinerary=(await api.getItinerary(date)).value;await commands.saveManifest(itinerary);
 assert.ok(itinerary.legs.some(l=>l.tripLegId===legId));
 const original=await commands.prepareStart({assignmentId:assignment,assignmentVersion:1,serviceDate:date});
 const started=(await api.startShift(original.request)).value;await commands.recordStart(original.request.idempotencyKey,started);
 const shift=started.shiftReference;let server=(await api.getShift(assignment)).value;assert.equal(server.lifecycle,'ACTIVE');
 const snapshot=await dispatcher(`${prefix}/runtime-dispatch-snapshot?serviceDate=${date}`);
 if(!server.precheck){
  const request={shiftGeneration:started.shiftGeneration,vehicleId:itinerary.legs.find(l=>l.tripLegId===legId).vehicleId,policyDigest:started.effectivePolicy.canonicalDigest,expectedVersion:server.resourceVersion,capturedAt:new Date().toISOString(),photos:[],
    inspection:{decision:'COMPLETED',definitionVersion:'inspection-synthetic-v2',entries:precheckItems.map(item=>({item,response:'NO_DEFECT'}))},odometer:{decision:'COMPLETED',value:10420,fuelLevel:'FULL'}};
  // Persist before submission so a rerun can recover the original check.
  const key='sol004-precheck-original-0001';db.exec('CREATE TABLE IF NOT EXISTS smoke_precheck(id INTEGER PRIMARY KEY,request TEXT)');
  db.prepare('INSERT OR IGNORE INTO smoke_precheck VALUES(1,?)').run(JSON.stringify(request));
  const saved=JSON.parse(db.prepare('SELECT request FROM smoke_precheck WHERE id=1').get().request);
  await api.submitPrecheck(shift,saved,key);
 }
 // Recover any interrupted prior run before selecting the next authoritative control.
 async function recover(){
  for(const p of await proofs.commands(shift))if(p.state==='PENDING')await proofs.record(p,(await api.submitSignature(p.shift,p.leg,p.request,p.key)).value);
  for(const q of await commands.actions(shift))if(q.state==='PENDING')await commands.recordAction(q,(await api.submitActions(q.request,q.batchKey)).value);
 }
 await recover();let lostResponseChecked=false;
 for(let step=0;step<16;step++){
  itinerary=(await api.getItinerary(date)).value;await commands.saveManifest(itinerary);const leg=itinerary.legs.find(l=>l.tripLegId===legId),e=leg.execution,c=e.serviceControl;
  server=(await api.getShift(assignment)).value;
  if(e.lifecycle==='COMPLETED')break;
  let command,details,event;
  if(e.lifecycle==='DISPATCHED')command='MARK_EN_ROUTE';
  else if(e.lifecycle==='EN_ROUTE_PICKUP')command='ARRIVE_PICKUP';
  else if(e.lifecycle==='ARRIVED_PICKUP'){
   if(!c.riderVerified){command='VERIFY_RIDER';details={verificationMethod:'NAME_CONFIRMED_WITH_RIDER'};}
   else if(!c.boardingSecure){command='SECURE_RIDER';details={occupantRestraint:'SECURED',mobilityDevice:'NOT_APPLICABLE'};}
   else if(!c.pickupEvidenceId)event='PICKUP_ATTESTATION';else command='BOARD_RIDER';
  }else if(e.lifecycle==='ONBOARD')command='ARRIVE_DROPOFF';
  else if(e.lifecycle==='ARRIVED_DROPOFF'){
   if(!c.safelyUnloaded){command='UNLOAD_RIDER';details={attestation:'UNLOADED_AND_ASSISTED'};}
   else if(!c.dropoffEvidenceId)event='DROPOFF_ATTESTATION';else command='COMPLETE_LEG';
  }else throw new Error('UNEXPECTED_EXECUTION_STATE');
  if(event){
   const now=new Date().toISOString(),offset=event==='PICKUP_ATTESTATION'?0:30;
   const unsigned={shiftGeneration:started.shiftGeneration,evidenceId:randomUUID(),expectedTag:e.expectedTag,event,attestationPolicyVersion:'attestation-synthetic-v2',policyVersion:c.proofRule.version,policyDigest:c.proofRule.digest,
    capturedAt:now,localActionAt:now,installationGeneration:'inst_synthetic0000001',parkedAttestation:true,role:'RIDER',points:Array.from({length:12},(_,i)=>[10+i*8+offset,10+(i%4)*9+offset])};
   const request={...unsigned,digest:createHash('sha256').update(`SIGNATURE:${cloudSignatureDigestInput(shift,legId,unsigned)}`).digest('hex')};
   const p=await proofs.prepare(shift,legId,request);await api.submitSignature(p.shift,p.leg,p.request,p.key);reopen();await recover();
  }else {
   const q=await commands.enqueue({shiftReference:shift,shiftGeneration:started.shiftGeneration,resourceReference:legId,expectedTag:e.expectedTag,serverSequence:server.lastActionSequence,command,details});
   // Deliberately lose the acknowledgement, reopen the durable client queue, replay unchanged.
   await api.submitActions(q.request,q.batchKey);reopen();assert.equal((await commands.actions(shift)).find(a=>a.batchKey===q.batchKey).state,'PENDING');await recover();lostResponseChecked=true;
  }
 }
 const final=(await api.getItinerary(date)).value.legs.find(l=>l.tripLegId===legId);assert.equal(final.execution.lifecycle,'COMPLETED');
 const finalShift=(await api.getShift(assignment)).value;let observed=false;
 for(let i=0;i<40;i++){
  const latest=await dispatcher(`${prefix}/runtime-dispatch-snapshot?serviceDate=${date}`);
  observed=Object.values(latest.projection).some(r=>r.resourceReference===`driver-shift:${shift}`&&r.resourceVersion===finalShift.resourceVersion);
  if(observed)break;await delay(1000);
 }
 assert.ok(observed,'dispatcher must receive the final committed shift invalidation');
 console.log(JSON.stringify({result:'SOL004_CLOUD_DRIVER_EXECUTION_VERIFIED',shiftReference:shift,executionVersion:final.execution.version,shiftVersion:finalShift.resourceVersion,
  acceptedActions:(await commands.actions(shift)).filter(a=>a.state==='ACCEPTED').length,acceptedProofs:(await proofs.commands(shift)).filter(p=>p.state==='ACCEPTED').length,lostResponseChecked,dispatcherObserved:observed,initialCursorCaptured:!!snapshot.cursor}));
}catch(error){console.error(error?.code??error?.message??'SOL004_SMOKE_FAILED');process.exitCode=1;}finally{db.close();}
