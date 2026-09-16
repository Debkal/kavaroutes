import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {chromium} from '@playwright/test';

const phase=process.argv[2],path=new URL('../../../.tooling/gcp/sol009-workflow.json',import.meta.url);
if(process.env.KAVAROUTES_VERIFY_PRIVATE_CLOUD!=='1'||!['assign','recover-assignment','approve','recover-approval','override','recover-override'].includes(phase))throw new Error('EXPLICIT_SOL009_WORKFLOW_PHASE_REQUIRED');
const origin='http://127.0.0.1:4311',prefix='/v1/organizations/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const runId='39000000-0000-4000-8000-000000000007',serviceDate='2026-09-15';
const headers={authorization:'Synthetic principal_dispatcher'};
let state;try{state=JSON.parse(await readFile(path,'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
if(phase==='assign'&&state)throw new Error('EXISTING_WORKFLOW_RESUME_ORIGINAL_RECEIPT');
if(phase==='recover-assignment'&&!state?.commandId)throw new Error('ORIGINAL_ASSIGNMENT_RECEIPT_REQUIRED');
if(phase==='approve'&&state?.phase!=='PROPOSAL_PENDING')throw new Error('PENDING_DRIVER_PROPOSAL_REQUIRED');
if(phase==='recover-approval'&&!state?.decisionId)throw new Error('ORIGINAL_DECISION_REQUIRED');
if(phase==='override'&&state?.phase!=='RETURN_REVIEW_REQUIRED')throw new Error('RECORDED_RETURN_EXCEPTION_REQUIRED');
if(phase==='recover-override'&&!state?.overrideId)throw new Error('ORIGINAL_OVERRIDE_REQUIRED');
const save=()=>writeFile(path,JSON.stringify(state,null,2)+'\n',{mode:0o600});
const browser=await chromium.launch({headless:true});
try{
 const page=await browser.newPage({viewport:{width:1440,height:900}});page.on('dialog',d=>d.accept());
 await page.goto(origin+'/dispatch');
 const section=page.getByRole('region',{name:'Cloud dispatch board'});
 await section.getByLabel('Service date',{exact:true}).fill(serviceDate);
 const get=async(path,auth=headers)=>{const r=await page.request.get(origin+prefix+path,{headers:auth});assert.equal(r.status(),200);return r.json();};
 const pending=(await get('/browser-commands/pending')).command;
 if(phase==='assign'){
  assert.equal(pending,null);
  const board=await get('/dispatch-board/'+serviceDate),index=board.runs.findIndex(r=>r.runId===runId);
  assert.ok(index>=0);assert.equal(board.runs[index].assignmentId,null);
  let lost=false;
  await page.route('**/browser-commands',async route=>{
   const input=route.request().postDataJSON();assert.equal(input.envelope.kind,'ASSIGN_RUN');
   assert.equal(input.envelope.resourceId,runId);
   state={phase:'ASSIGNMENT_PREPARED',serviceDate,runId,commandId:input.id,envelope:input.envelope};await save();await route.continue();
  });
  await page.route('**/browser-commands/*/execute',async route=>{
   assert.equal(lost,false);const r=await route.fetch();assert.equal(r.status(),200);
   const record=await r.json();assert.equal(record.id,state.commandId);assert.equal(record.result.outcome,'ACCEPTED');
   state={...state,phase:'ASSIGNMENT_COMMITTED_RESPONSE_LOST',assignmentId:record.result.body.assignmentId};
   assert.ok(state.assignmentId);await save();lost=true;await route.abort('failed');
  });
  await section.getByRole('button',{name:`View run ${index+1}`,exact:true}).click();
  await section.getByRole('combobox',{name:'Driver',exact:true}).selectOption('30000000-0000-4000-8000-000000000001');
  await section.getByRole('combobox',{name:'Vehicle',exact:true}).selectOption('32000000-0000-4000-8000-000000000006');
  await section.getByRole('button',{name:'Confirm assignment',exact:true}).click();
  await section.getByRole('status').filter({hasText:'Outcome unknown.'}).waitFor();assert.ok(lost);
 }else if(phase==='recover-assignment'){
  assert.equal(pending.id,state.commandId);assert.deepEqual(pending.envelope,state.envelope);
  assert.equal(pending.result.outcome,'ACCEPTED');assert.equal(pending.result.body.assignmentId,state.assignmentId);
  const recovery=page.getByRole('region',{name:'Dispatcher command recovery'});
  await recovery.getByRole('button',{name:'Acknowledge reviewed result',exact:true}).click();
  await recovery.getByText('No unacknowledged command.',{exact:true}).waitFor();
  const board=await get('/dispatch-board/'+serviceDate),run=board.runs.find(r=>r.runId===runId);
  assert.equal(run.assignmentId,state.assignmentId);assert.equal(run.version,2);
  const itinerary=await get('/driver/itineraries/'+serviceDate,{authorization:'Synthetic principal_driver'});
  const legs=itinerary.legs.filter(l=>l.runId===runId);
  assert.equal(legs.length,2);assert.ok(legs.every(l=>l.assignmentId===state.assignmentId&&l.execution.lifecycle==='DISPATCHED'));
  state.phase='ASSIGNMENT_VERIFIED';await save();
 }else if(phase==='approve'){
  assert.equal(pending,null);let lost=false;
  const view=await get(`/dispatch/shifts/${state.shiftId}/route-proposals`);
  const index=view.proposals.findIndex(p=>p.proposalId===state.proposalId);assert.ok(index>=0);
  assert.equal(view.proposals[index].state,'PENDING_DISPATCH_APPROVAL');
  state.originalRunVersion=view.runVersion;
  await page.route('**/browser-commands',async route=>{
   const input=route.request().postDataJSON();assert.equal(input.envelope.kind,'DECIDE_ROUTE');assert.equal(input.envelope.resourceId,state.proposalId);
   state.decisionId=input.id;state.decisionEnvelope=input.envelope;state.phase='DECISION_PREPARED';await save();await route.continue();
  });
  await page.route('**/browser-commands/*/execute',async route=>{
   assert.equal(lost,false);const response=await route.fetch();assert.equal(response.status(),200);
   const record=await response.json();assert.equal(record.id,state.decisionId);assert.equal(record.result.outcome,'ACCEPTED');
   assert.equal(record.result.body.state,'APPROVED');state.phase='DECISION_COMMITTED_RESPONSE_LOST';await save();lost=true;await route.abort('failed');
  });
  await section.getByRole('combobox',{name:'Recorded shift',exact:true}).selectOption(state.shiftId);
  await section.getByRole('button',{name:`Approve proposal ${index+1}`,exact:true}).click();
  await section.getByRole('status').filter({hasText:'Outcome unknown.'}).waitFor();assert.ok(lost);
 }else if(phase==='recover-approval'){
  if(!state.decisionAcknowledged){
   assert.equal(pending.id,state.decisionId);assert.deepEqual(pending.envelope,state.decisionEnvelope);
   assert.equal(pending.result.outcome,'ACCEPTED');assert.equal(pending.result.body.state,'APPROVED');
   const recovery=page.getByRole('region',{name:'Dispatcher command recovery'});
   await recovery.getByRole('button',{name:'Acknowledge reviewed result',exact:true}).click();
   await recovery.getByText('No unacknowledged command.',{exact:true}).waitFor();
   state.decisionAcknowledged=true;await save();
  }
  const view=await get(`/dispatch/shifts/${state.shiftId}/route-proposals`);
  assert.equal(view.proposals.find(p=>p.proposalId===state.proposalId).state,'APPROVED');
  assert.equal(view.runVersion,state.originalRunVersion+1);assert.deepEqual(view.nodes.map(n=>n.nodeId),state.proposedOrder);
  const driverView=await get(`/driver/shifts/${state.shiftId}/route-proposals`,{authorization:'Synthetic principal_driver'});
  assert.deepEqual(driverView.nodes.map(n=>n.nodeId),state.proposedOrder);
  const itinerary=await get('/driver/itineraries/'+serviceDate,{authorization:'Synthetic principal_driver'});
  const legs=itinerary.legs.filter(l=>l.runId===runId);
  assert.deepEqual(legs.map(l=>l.tripLegId),['39000000-0000-4000-8000-000000000015','39000000-0000-4000-8000-000000000005']);
  state.phase='ROUTE_APPROVED';await save();
 }else{
  const snapshot=await get('/runtime-dispatch-snapshot?serviceDate='+serviceDate);
  const shifts=Object.values(snapshot.projection).filter(r=>r.resourceKind==='driver-shift');
  const index=shifts.findIndex(r=>r.resourceReference===`driver-shift:${state.shiftId}`);assert.ok(index>=0);
  const card=section.locator('article').filter({has:page.getByRole('heading',{name:new RegExp(`^Shift ${index+1}:`)})});
  await card.getByRole('button',{name:'Open synthetic authorized return reviewer',exact:true}).click();
  const reviewerHeaders={authorization:'Synthetic principal_policy_override'};
  const original=(await get('/browser-commands/pending',reviewerHeaders)).command;
  if(phase==='override'){
   assert.equal(original,null);let lost=false;
   await page.route('**/browser-commands',async route=>{
    const input=route.request().postDataJSON();assert.equal(input.envelope.kind,'OVERRIDE_RETURN');assert.equal(input.envelope.resourceId,state.shiftId);
    state.overrideId=input.id;state.overrideEnvelope=input.envelope;state.phase='OVERRIDE_PREPARED';await save();await route.continue();
   });
   await page.route('**/browser-commands/*/execute',async route=>{
    assert.equal(lost,false);const response=await route.fetch();assert.equal(response.status(),200);const record=await response.json();
    assert.equal(record.id,state.overrideId);assert.equal(record.result.outcome,'ACCEPTED');assert.equal(record.result.body.lifecycle,'SHIFT_ENDED');
    state.phase='OVERRIDE_COMMITTED_RESPONSE_LOST';await save();lost=true;await route.abort('failed');
   });
   await card.getByRole('button',{name:'Record audited return override',exact:true}).click();
   await card.getByRole('status').filter({hasText:'Outcome unknown.'}).waitFor();assert.ok(lost);
  }else{
   if(!state.overrideAcknowledged){
    assert.equal(original.id,state.overrideId);assert.deepEqual(original.envelope,state.overrideEnvelope);assert.equal(original.result.body.lifecycle,'SHIFT_ENDED');
    const recovery=card.getByRole('region',{name:'Authorized reviewer command recovery'});
    await recovery.getByRole('button',{name:'Acknowledge reviewed result',exact:true}).click();
    await recovery.getByText('No unacknowledged command.',{exact:true}).waitFor();state.overrideAcknowledged=true;await save();
   }
   await card.getByText('Server confirms this shift has ended. No further override is allowed.',{exact:true}).waitFor();
   assert.equal(await card.getByRole('button',{name:'Record audited return override',exact:true}).isDisabled(),true);
   const status=await get(`/dispatch/shifts/${state.shiftId}/status`);
   assert.equal(status.tracking.status,'SHIFT_ENDED');assert.equal(status.tracking.contactDriver,false);
   state.phase='SHIFT_ENDED';await save();
  }
 }
 console.log(`SOL009_${state.phase}`);
}finally{await browser.close();}
