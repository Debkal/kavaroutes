import assert from 'node:assert/strict';
import {randomUUID,randomInt,createHash} from 'node:crypto';
import {readFile,writeFile,chmod} from 'node:fs/promises';
import {DatabaseSync} from 'node:sqlite';
import {createCloudDriverApi} from '../../../apps/driver/src/cloud-server.ts';
import {createCloudCommandStore} from '../../../apps/driver/src/cloud-command-store.ts';
import {createCloudPrecheckStore} from '../../../apps/driver/src/cloud-precheck-store.ts';
import {createCloudRouteStore} from '../../../apps/driver/src/cloud-route-store.ts';
import {createCloudSignatureStore} from '../../../apps/driver/src/cloud-signature-store.ts';
import {cloudSignatureDigestInput} from '../../../apps/driver/src/cloud-signature.ts';
import {createCloudFinishStore} from '../../../apps/driver/src/cloud-finish-store.ts';
import {recoverCloudFinish} from '../../../apps/driver/src/cloud-finish.ts';
import {DRIVER_MIGRATIONS} from '../../../packages/driver-core/dist/index.js';
import {precheckItems} from '../../../packages/api-contracts/dist/index.js';

const phase=process.argv[2];
if(process.env.KAVAROUTES_VERIFY_PRIVATE_CLOUD!=='1'||!['start','propose','execute','review-test-signature','finish'].includes(phase))throw new Error('EXPLICIT_SOL009_DRIVER_PHASE_REQUIRED');
const statePath='.tooling/gcp/sol009-workflow.json',path='.tooling/gcp/sol009-client-recovery.sqlite';
const state=JSON.parse(await readFile(statePath,'utf8'));
assert.equal(state.runId,'39000000-0000-4000-8000-000000000007');assert.ok(state.assignmentId);
assert.ok((phase==='start'?['ASSIGNMENT_VERIFIED','PRECHECK_VERIFIED']:phase==='propose'?['PRECHECK_VERIFIED','PROPOSAL_PENDING']:phase==='finish'?['EXECUTION_VERIFIED','RETURN_REVIEW_REQUIRED','SHIFT_ENDED']:['ROUTE_APPROVED','EXECUTION_VERIFIED']).includes(state.phase));
// Desktop synthetic adapter/reopen evidence only, not native SQLCipher/device proof.
let db=new DatabaseSync(path),tail=Promise.resolve();await chmod(path,0o600);
const adapter={getFirstAsync:async(sql,...p)=>db.prepare(sql).get(...p)??null,
 getAllAsync:async(sql,...p)=>db.prepare(sql).all(...p),runAsync:async(sql,...p)=>db.prepare(sql).run(...p),
 withExclusiveTransactionAsync:fn=>{const call=tail.then(async()=>{db.exec('BEGIN');try{await fn(adapter);db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e;}});tail=call.catch(()=>{});return call;}};
const reopen=()=>{db.close();db=new DatabaseSync(path);};
const save=()=>writeFile(statePath,JSON.stringify(state,null,2)+'\n',{mode:0o600});
const api=createCloudDriverApi({baseUrl:'http://127.0.0.1:58080',fetch});
const commands=createCloudCommandStore(adapter,{uuid:randomUUID,now:()=>new Date().toISOString()});
const precheck=createCloudPrecheckStore(adapter,{newKey:randomUUID,now:()=>new Date().toISOString()});
const routes=createCloudRouteStore(adapter,randomUUID);
const proofs=createCloudSignatureStore(adapter,randomUUID);
const finish=createCloudFinishStore(adapter,randomUUID);
const post=createCloudPrecheckStore(adapter,{newKey:randomUUID,now:()=>new Date().toISOString(),stage:'POST'});
try{
 db.exec('CREATE TABLE IF NOT EXISTS smoke_migration(version INTEGER PRIMARY KEY)');
 for(const m of DRIVER_MIGRATIONS)if(!db.prepare('SELECT 1 FROM smoke_migration WHERE version=?').get(m.version)){
  db.exec('BEGIN');try{db.exec(m.sql);db.prepare('INSERT INTO smoke_migration VALUES(?)').run(m.version);db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e;}
 }
 await api.authenticate();const itinerary=(await api.getItinerary(state.serviceDate)).value;
 const legs=itinerary.legs.filter(l=>l.assignmentId===state.assignmentId);assert.equal(legs.length,2);
 await commands.saveManifest(itinerary);
 if(phase==='start'){
  let original=await commands.prepareStart({assignmentId:state.assignmentId,assignmentVersion:legs[0].assignmentVersion,serviceDate:state.serviceDate});
  assert.equal(original.request.assignmentId,state.assignmentId);
  if(original.state==='PENDING'){
   await api.startShift(original.request);reopen();
   const restored=await commands.start();assert.deepEqual(restored.request,original.request);assert.equal(restored.state,'PENDING');
   await commands.recordStart(restored.request.idempotencyKey,(await api.startShift(restored.request)).value);
  }
  original=await commands.start();assert.equal(original.state,'ACCEPTED');state.shiftId=original.receipt.shiftReference;await save();
  const shift=(await api.getShift(state.assignmentId)).value;assert.equal(shift.lifecycle,'ACTIVE');
  if(!shift.precheck){
   const check=await precheck.prepare(state.shiftId,{shiftGeneration:original.receipt.shiftGeneration,
    vehicleId:legs[0].vehicleId,policyDigest:original.receipt.effectivePolicy.canonicalDigest,
    expectedVersion:shift.resourceVersion,capturedAt:new Date().toISOString(),photos:[],
    inspection:{decision:'COMPLETED',definitionVersion:'inspection-synthetic-v2',entries:precheckItems.map(item=>({item,response:'NO_DEFECT'}))},
    odometer:{decision:'COMPLETED',value:10440,fuelLevel:'FULL'}});
   await api.submitPrecheck(state.shiftId,check.request,check.key);reopen();
  }
  const saved=await precheck.read(state.shiftId);assert.ok(saved);
  if(saved.state==='PENDING')await precheck.record(state.shiftId,saved.key,(await api.submitPrecheck(state.shiftId,saved.request,saved.key)).value);
  assert.equal((await precheck.read(state.shiftId)).state,'ACCEPTED');
  assert.ok((await api.getShift(state.assignmentId)).value.precheck);
  state.phase='PRECHECK_VERIFIED';await save();
 }else if(phase==='propose'){
  const original=await commands.start();assert.equal(original.receipt.shiftReference,state.shiftId);
  let pending=(await routes.commands(state.shiftId))[0];
  if(!pending){
   const view=(await api.getRouteProposals(state.shiftId)).value;assert.equal(view.nodes.length,4);
   const order=[...view.nodes.slice(2),...view.nodes.slice(0,2)].map(n=>n.nodeId);
   await routes.save(view,order);pending=await routes.prepare(view,order);
  }
  if(pending.state==='PENDING'){
   const receipt=(await api.submitRouteProposal(state.shiftId,pending.request,pending.command_key)).value;
   assert.equal(receipt.state,'PENDING_DISPATCH_APPROVAL');reopen();
   const restored=(await routes.commands(state.shiftId)).find(c=>c.proposal_id===pending.proposal_id);
   assert.equal(restored.state,'PENDING');assert.deepEqual(restored.request,pending.request);
   const replay=(await api.submitRouteProposal(state.shiftId,restored.request,restored.command_key)).value;
   assert.deepEqual(replay,receipt);await routes.record(restored,replay);
  }
  const view=(await api.getRouteProposals(state.shiftId)).value;
  const proposal=view.proposals.find(p=>p.proposalId===pending.proposal_id);assert.equal(proposal.state,'PENDING_DISPATCH_APPROVAL');
  assert.equal(view.runVersion,pending.request.expectedRunVersion,'Driver proposal cannot approve itself');
  state.proposalId=pending.proposal_id;state.proposedOrder=pending.request.nodeOrder;state.phase='PROPOSAL_PENDING';await save();
 }else if(phase==='finish'){
  assert.ok(legs.every(l=>l.execution.lifecycle==='COMPLETED'));
  let closure=(await api.getClosure(state.shiftId)).value;
  const original=await commands.start();assert.equal(original.receipt.shiftReference,state.shiftId);
  if(closure.lifecycle!=='SHIFT_ENDED'){
   if(!closure.postcheck){
    const check=await post.prepare(state.shiftId,{shiftGeneration:closure.shiftGeneration,vehicleId:legs[0].vehicleId,
     policyDigest:original.receipt.effectivePolicy.canonicalDigest,expectedVersion:closure.resourceVersion,
     capturedAt:new Date().toISOString(),photos:[],inspection:{decision:'COMPLETED',definitionVersion:'inspection-synthetic-v2',entries:precheckItems.map(item=>({item,response:'NO_DEFECT'}))},
     odometer:{decision:'COMPLETED',value:10460,fuelLevel:'FULL'}});
    await api.submitPostcheck(state.shiftId,check.request,check.key);reopen();
   }
   const check=await post.read(state.shiftId);assert.ok(check);
   if(check.state==='PENDING')await post.record(state.shiftId,check.key,(await api.submitPostcheck(state.shiftId,check.request,check.key)).value);
   assert.equal((await post.read(state.shiftId)).state,'ACCEPTED');
   closure=(await api.getClosure(state.shiftId)).value;
   let close=(await finish.list(state.shiftId)).find(c=>c.kind==='CLOSE');
   if(!close)close=await finish.prepare(state.shiftId,'CLOSE',{commandId:randomUUID(),shiftGeneration:closure.shiftGeneration,
    expectedVersion:closure.resourceVersion,kind:'SIGN_OFF',reason:'NORMAL_SIGN_OFF',parkedAttestation:true});
   if(close.state==='PENDING'){await api.submitClosure(state.shiftId,close.request,close.key);reopen();}
   closure=await recoverCloudFinish(api,finish,state.shiftId,async()=>{});
  }
  assert.ok(closure.lifecycle==='SHIFT_ENDED'||closure.lastEvent==='RETURN_EXCEPTION');
  state.phase=closure.lifecycle==='SHIFT_ENDED'?'SHIFT_ENDED':'RETURN_REVIEW_REQUIRED';await save();
 }else if(phase==='review-test-signature'){
  const pending=(await proofs.commands(state.shiftId)).filter(p=>p.state==='PENDING');assert.equal(pending.length,1);
  const p=pending[0],old=new DatabaseSync('.tooling/gcp/sol004-client-recovery.sqlite',{readOnly:true});
  let copied;
  try{copied=old.prepare("SELECT encrypted_request FROM cloud_signature_command WHERE state='ACCEPTED'").all().some(row=>
   JSON.stringify(JSON.parse(new TextDecoder().decode(row.encrypted_request)).points)===JSON.stringify(p.request.points));}finally{old.close();}
  assert.equal(copied,true,'review is limited to the accidentally reused synthetic strokes');
  const response=await fetch(`http://127.0.0.1:58080/v1/organizations/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/driver/shifts/${p.shift}/legs/${p.leg}/evidence/signatures`,{
   method:'POST',headers:{authorization:'Synthetic principal_driver','content-type':'application/json','idempotency-key':p.key},body:JSON.stringify(p.request)});
  assert.equal(response.status,409);const problem=await response.json();assert.equal(problem.code,'PERSISTENCE_DUPLICATE');
  await proofs.record(p,null,'PERSISTENCE_DUPLICATE');
  state.signatureFixtureReview='REUSED_SOL004_STROKES_REJECTED_ORIGINAL_PRESERVED';await save();
  console.log('SOL009_DUPLICATE_TEST_STROKES_CONFIRMED_AND_REJECTION_RECORDED');
 }else{
  const original=await commands.start();assert.equal(original.receipt.shiftReference,state.shiftId);
  const shift=state.shiftId,generation=original.receipt.shiftGeneration;
  const recover=async()=>{
   for(const p of await proofs.commands(shift))if(p.state==='PENDING')await proofs.record(p,(await api.submitSignature(p.shift,p.leg,p.request,p.key)).value);
   for(const q of await commands.actions(shift))if(q.state==='PENDING')await commands.recordAction(q,(await api.submitActions(q.request,q.batchKey)).value);
  };
  await recover();
  const offline=createCloudDriverApi({baseUrl:'http://127.0.0.1:58080',fetch:async()=>{throw new TypeError('SYNTHETIC_OFFLINE');}});
  await assert.rejects(()=>offline.getItinerary(state.serviceDate));reopen();
  assert.equal((await commands.manifest()).legs.filter(l=>l.assignmentId===state.assignmentId).length,2);
  for(let step=0;step<40;step++){
   const itinerary=(await api.getItinerary(state.serviceDate)).value;await commands.saveManifest(itinerary);
   const current=itinerary.legs.filter(l=>l.assignmentId===state.assignmentId);
   assert.deepEqual(current.map(l=>l.tripLegId),['39000000-0000-4000-8000-000000000015','39000000-0000-4000-8000-000000000005']);
   const leg=current.find(l=>l.execution.lifecycle!=='COMPLETED');if(!leg)break;
   const e=leg.execution,c=e.serviceControl,server=(await api.getShift(state.assignmentId)).value;
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
    const now=new Date().toISOString();
    const unsigned={shiftGeneration:generation,evidenceId:randomUUID(),expectedTag:e.expectedTag,event,
     attestationPolicyVersion:'attestation-synthetic-v2',policyVersion:c.proofRule.version,policyDigest:c.proofRule.digest,
     capturedAt:now,localActionAt:now,installationGeneration:'inst_synthetic0000001',parkedAttestation:true,role:'RIDER',
     // Each capture is a new synthetic mark; server anti-reuse remains enabled.
     points:Array.from({length:12},(_,i)=>[10+i*8,10+(i%4)*9+randomInt(0,16)])};
    const request={...unsigned,digest:createHash('sha256').update(`SIGNATURE:${cloudSignatureDigestInput(shift,leg.tripLegId,unsigned)}`).digest('hex')};
    const p=await proofs.prepare(shift,leg.tripLegId,request);await api.submitSignature(p.shift,p.leg,p.request,p.key);reopen();
    const saved=(await proofs.commands(shift)).find(row=>row.key===p.key);assert.equal(saved.state,'PENDING');assert.deepEqual(saved.request,p.request);
   }else{
    const q=await commands.enqueue({shiftReference:shift,shiftGeneration:generation,resourceReference:leg.tripLegId,
     expectedTag:e.expectedTag,serverSequence:server.lastActionSequence,command,details});
    await api.submitActions(q.request,q.batchKey);reopen();
    const saved=(await commands.actions(shift)).find(row=>row.batchKey===q.batchKey);assert.equal(saved.state,'PENDING');assert.deepEqual(saved.request,q.request);
   }
   await recover();assert.ok((await commands.actions(shift)).every(q=>q.state==='ACCEPTED'));
  }
  const completed=(await api.getItinerary(state.serviceDate)).value.legs.filter(l=>l.assignmentId===state.assignmentId);
  assert.ok(completed.every(l=>l.execution.lifecycle==='COMPLETED'));
  assert.equal((await commands.actions(shift)).filter(q=>q.state==='ACCEPTED').length,16);
  assert.equal((await proofs.commands(shift)).filter(q=>q.state==='ACCEPTED').length,4);
  state.phase='EXECUTION_VERIFIED';await save();
 }
 console.log(`SOL009_DRIVER_${state.phase}_REOPEN_VERIFIED`);
}finally{db.close();}
