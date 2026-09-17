import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {DatabaseSync} from 'node:sqlite';
import {chromium} from '@playwright/test';
import {createCloudDriverApi} from '../../driver/src/cloud-server.ts';
if(process.env.KAVAROUTES_VERIFY_PRIVATE_CLOUD!=='1')throw new Error('EXPLICIT_PRIVATE_CLOUD_VERIFICATION_REQUIRED');
const path=new URL('../../../.tooling/gcp/sol009-workflow.json',import.meta.url),state=JSON.parse(await readFile(path,'utf8'));
assert.ok(['SHIFT_ENDED','WORKFLOW_VERIFIED'].includes(state.phase));
const origin='http://127.0.0.1:4311',prefix='/v1/organizations/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const driver=createCloudDriverApi({baseUrl:'http://127.0.0.1:58080',fetch});
const closure=(await driver.getClosure(state.shiftId)).value;
assert.equal(closure.lifecycle,'SHIFT_ENDED');assert.equal(closure.collectionStopped,true);
assert.equal(closure.postcheck.inspectionOutcome,'COMPLETED');assert.equal(closure.postcheck.odometer,10460);
const itinerary=(await driver.getItinerary(state.serviceDate)).value;
const legs=itinerary.legs.filter(l=>l.assignmentId===state.assignmentId);assert.equal(legs.length,2);
// Active-shift proof handles deliberately disappear after sign-off. Prove their
// accepted pre-closure projection and immutable receipts, not broader history access.
const db=new DatabaseSync('.tooling/gcp/sol009-client-recovery.sqlite',{readOnly:true});
try{
 const decode=value=>JSON.parse(new TextDecoder().decode(value));
 const saved=decode(db.prepare('SELECT encrypted_projection FROM cloud_driver_manifest WHERE id=1').get().encrypted_projection);
 const receipts=db.prepare("SELECT encrypted_receipt FROM cloud_signature_command WHERE shift_reference=? AND state='ACCEPTED'").all(state.shiftId).map(r=>decode(r.encrypted_receipt));
 assert.equal(receipts.length,4);
 for(const leg of legs){
  assert.equal(leg.execution.lifecycle,'COMPLETED');
  assert.equal(leg.execution.serviceControl.pickupEvidenceId,null);assert.equal(leg.execution.serviceControl.dropoffEvidenceId,null);
  const prior=saved.legs.find(l=>l.tripLegId===leg.tripLegId);assert.equal(prior.execution.version,leg.execution.version);
  for(const [event,field] of [['PICKUP_ATTESTATION','pickupEvidenceId'],['DROPOFF_ATTESTATION','dropoffEvidenceId']]){
   const receipt=receipts.find(r=>r.tripLegId===leg.tripLegId&&r.event===event);assert.ok(receipt);
   assert.equal(receipt.status,'ACCEPTED_FOR_SERVICE_CONTROL');assert.equal(receipt.evidenceId,prior.execution.serviceControl[field]);
  }
 }
}finally{db.close();}
const trips=legs.map(l=>l.tripId).sort();
const browser=await chromium.launch({headless:true});
try{
 const page=await browser.newPage({viewport:{width:390,height:844}});
 await page.goto(origin+'/dispatch');await page.getByRole('region',{name:'Cloud dispatch board'}).getByLabel('Service date',{exact:true}).fill(state.serviceDate);
 const status=await page.request.get(`${origin}${prefix}/dispatch/shifts/${state.shiftId}/status`,{headers:{authorization:'Synthetic principal_dispatcher'}});
 assert.equal(status.status(),200);const ended=await status.json();assert.equal(ended.tracking.status,'SHIFT_ENDED');assert.equal(ended.tracking.contactDriver,false);
 await page.getByRole('heading',{name:/Shift ended — collection stopped/}).waitFor();
 const requests=[];page.on('request',r=>{if(new URL(page.url()).pathname==='/clients'&&r.url().includes('/v1/'))requests.push(new URL(r.url()).pathname);});
 await page.getByRole('link',{name:/Clients/}).click();await page.getByRole('heading',{name:'Clients',exact:true}).waitFor();
 await page.getByLabel('Service date',{exact:true}).fill(state.serviceDate);
 const headers={authorization:'Synthetic principal_facility'};
 const response=await page.request.get(`${origin}${prefix}/facility/days/${state.serviceDate}?limit=100`,{headers});assert.equal(response.status(),200);
 const day=await response.json();assert.deepEqual(day.items.map(t=>t.relatedTripReference).sort(),trips);
 assert.ok(day.items.every(t=>t.lifecycle==='COMPLETED'));
 for(const trip of day.items)assert.deepEqual(Object.keys(trip).sort(),['lifecycle','relatedTripReference','scheduledAt']);
 for(let i=1;i<=2;i++){
  await page.getByRole('button',{name:`View trip ${i}`,exact:true}).click();
  await page.getByRole('region',{name:'Selected client trip'}).getByText(/COMPLETED/).waitFor();
  await page.getByRole('button',{name:'Close trip details',exact:true}).click();
 }
 await page.waitForTimeout(5500);
 assert.equal(requests.some(p=>p.includes('runtime-dispatch')||p.includes('/dispatch/')||p.includes('/driver/')),false);
 await page.reload();await page.getByLabel('Service date',{exact:true}).fill(state.serviceDate);
 await page.getByRole('button',{name:'View trip 2',exact:true}).click();
 await page.getByRole('region',{name:'Selected client trip'}).getByText(/COMPLETED/).waitFor();
 state.phase='WORKFLOW_VERIFIED';await writeFile(path,JSON.stringify(state,null,2)+'\n',{mode:0o600});
 console.log('SOL009_DRIVER_CLOSED_DISPATCH_STOPPED_FACILITY_COMPLETED_RELOAD_VERIFIED');
}finally{await browser.close();}
