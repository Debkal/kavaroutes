import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {chromium} from '@playwright/test';
const phase=process.argv[2],path=new URL('../../../.tooling/gcp/sol009-web-recovery.json',import.meta.url);
if(process.env.KAVAROUTES_VERIFY_PRIVATE_CLOUD!=='1'||!['create','recover-create','cancel','verify'].includes(phase))throw new Error('EXPLICIT_SOL009_PHASE_REQUIRED');
let state;try{state=JSON.parse(await readFile(path,'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
if(phase==='create'&&state)throw new Error('EXISTING_SOL009_RECEIPT_REQUIRES_RESUME_NOT_RECREATE');
if(phase!=='create'&&!state)throw new Error('ORIGINAL_RECEIPT_REQUIRED');
const base='http://127.0.0.1:4311',prefix='/v1/organizations/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',headers={authorization:'Synthetic principal_dispatcher'};
const save=()=>writeFile(path,JSON.stringify(state,null,2)+'\n',{mode:0o600});
const browser=await chromium.launch({headless:true});
try{
 const page=await browser.newPage();page.on('dialog',dialog=>dialog.accept());await page.goto(base+'/dispatch');
 const recovery=page.getByRole('region',{name:'Dispatcher command recovery'});await recovery.waitFor();
 const readPending=async()=>{const response=await page.request.get(base+prefix+'/browser-commands/pending',{headers});assert.equal(response.status(),200);return (await response.json()).command;};
 if(phase==='create'||phase==='cancel'){
  assert.equal(await readPending(),null,'resolve prior principal command before this test');
  if(phase==='cancel')assert.equal(state.phase,'CREATE_VERIFIED');
  const kind=phase==='create'?'CREATE_TRIP':'CANCEL_TRIP';let lost=false;
  await page.route('**/browser-commands',async route=>{
   const input=route.request().postDataJSON();assert.equal(input.envelope.kind,kind);
   state=phase==='create'?{phase:'CREATE_STARTED',tripId:input.envelope.body.tripId,createId:input.id}:{...state,phase:'CANCEL_STARTED',cancelId:input.id};
   await save();await route.continue();
  });
  await page.route('**/browser-commands/*/execute',async route=>{
   assert.equal(lost,false);const response=await route.fetch();assert.equal(response.status(),200);const body=await response.json();assert.equal(body.result.outcome,'ACCEPTED');
   assert.equal(body.id,phase==='create'?state.createId:state.cancelId);state.committed=true;await save();lost=true;await route.abort('failed');
  });
  if(phase==='create')await page.getByRole('button',{name:'Create synthetic cloud trip',exact:true}).click();
  else{
   const section=page.getByRole('region',{name:'Persisted cloud trips'}),row=section.getByRole('row').filter({hasText:state.tripId});
   await section.waitFor();
   for(let i=0;await row.count()===0&&i<20;i++){const next=section.getByRole('button',{name:'Next page',exact:true});assert.equal(await next.isEnabled(),true);const loaded=page.waitForResponse(r=>r.url().includes('/trips?'));await next.click();await loaded;}
   await row.getByRole('button',{name:'Cancel trip',exact:true}).click();
  }
  await page.getByRole('status').filter({hasText:'Outcome unknown. Retry the same command'}).waitFor();assert.equal(lost,true);
  console.log(`SOL009_${phase.toUpperCase()}_COMMITTED_RESPONSE_LOST`);
 }else{
  const id=phase==='recover-create'?state.createId:state.cancelId;assert.ok(id);
  const pending=await readPending();assert.equal(pending.id,id);assert.equal(pending.result.outcome,'ACCEPTED');
  await recovery.getByRole('button',{name:'Acknowledge reviewed result',exact:true}).click();await recovery.getByText('No unacknowledged command.',{exact:true}).waitFor();
  const response=await page.request.get(base+prefix+'/trips/'+state.tripId,{headers});assert.equal(response.status(),200);const trip=await response.json();assert.equal(trip.lifecycle,phase==='recover-create'?'DRAFT':'CANCELLED');assert.equal(trip.version,phase==='recover-create'?1:2);
  state.phase=phase==='recover-create'?'CREATE_VERIFIED':'COMPLETE';await save();console.log(`SOL009_${state.phase}_ORIGINAL_RECEIPT_RELOAD_VERIFIED`);
 }
}finally{await browser.close();}
