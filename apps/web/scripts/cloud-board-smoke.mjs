import assert from 'node:assert/strict';
import {chromium} from '@playwright/test';

if(process.env.KAVAROUTES_VERIFY_PRIVATE_CLOUD!=='1')throw new Error('EXPLICIT_PRIVATE_CLOUD_VERIFICATION_REQUIRED');
const origin='http://127.0.0.1:4311',prefix='/v1/organizations/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const runId='35000000-0000-4000-8000-000000000007',legId='35000000-0000-4000-8000-000000000005';
const browser=await chromium.launch({headless:true});
try{
 const page=await browser.newPage({viewport:{width:1440,height:900}});
 await page.goto(`${origin}/dispatch`);
 const section=page.getByRole('region',{name:'Cloud dispatch board'});
 await section.getByRole('button',{name:'View run 2'}).waitFor();
 const boardResponse=await page.request.get(`${origin}${prefix}/dispatch-board/2026-09-14`,{headers:{authorization:'Synthetic principal_dispatcher'}});
 assert.equal(boardResponse.status(),200);
 const before=(await boardResponse.json()).runs.find(r=>r.runId===runId);
 assert.ok(before);
 if(before.assignmentId)throw new Error('FIXTURE_ALREADY_ASSIGNED_REVIEW_EXISTING_EVIDENCE');
 let receipt,original,originalKey;
 await page.route(`**/dispatch/runs/${runId}/commands/assign`,async route=>{
  if(!original){
   original=route.request().postDataJSON();originalKey=route.request().headers()['idempotency-key'];
   const response=await route.fetch();assert.equal(response.status(),200);receipt=await response.json();
   await route.abort('connectionfailed');
  }else{
   assert.deepEqual(route.request().postDataJSON(),original);assert.equal(route.request().headers()['idempotency-key'],originalKey);
   await route.continue();
  }
 });
 await section.getByRole('button',{name:'View run 2'}).click();
 await section.getByRole('combobox',{name:'Driver',exact:true}).selectOption('30000000-0000-4000-8000-000000000001');
 await section.getByRole('combobox',{name:'Vehicle',exact:true}).selectOption('32000000-0000-4000-8000-000000000006');
 page.once('dialog',dialog=>dialog.accept());
 await section.getByRole('button',{name:'Confirm assignment'}).click();
 await section.getByText(/Outcome unknown/).waitFor();
 await section.getByRole('button',{name:'Recover original assignment'}).click();
 await section.getByText('Assignment confirmed by the server. Driver itinerary updated.').waitFor();
 const driver=await page.request.get(`${origin}${prefix}/driver/itineraries/2026-09-14`,{headers:{authorization:'Synthetic principal_driver'}});
 assert.equal(driver.status(),200);
 const legs=(await driver.json()).legs;
 assert.equal(legs.find(l=>l.tripLegId===legId).assignmentId,receipt.assignmentId);
 assert.equal(legs.find(l=>l.tripLegId===legId).execution.lifecycle,'DISPATCHED');
 assert.equal(legs.find(l=>l.tripLegId==='32000000-0000-4000-8000-000000000005').execution.lifecycle,'COMPLETED');
 const stale=await page.request.post(`${origin}${prefix}/dispatch/runs/${runId}/commands/assign`,{headers:{authorization:'Synthetic principal_dispatcher','if-match':before.expectedTag,'idempotency-key':'sol005-browser-stale-0001'},data:original});
 assert.equal(stale.status(),412);
 await page.reload();await section.getByRole('button',{name:'View run 2'}).click();
 await section.getByText('Run details · version 2').waitFor();
 await section.getByRole('button',{name:'View run 1'}).click();
 await section.getByText(/completed · trip draft/).waitFor();
 let delivered=false;
 for(let i=0;i<30;i++){
  const res=await page.request.get(`${origin}${prefix}/runtime-dispatch-snapshot?serviceDate=2026-09-14`,{headers:{authorization:'Synthetic principal_dispatcher'}});
  assert.equal(res.status(),200);
  if(Object.values((await res.json()).projection).some(d=>d.resourceReference===`run:${runId}`&&d.resourceVersion===receipt.version)){delivered=true;break;}
  await page.waitForTimeout(1000);
 }
 assert.equal(delivered,true);
 console.log(JSON.stringify({result:'SOL005_CLOUD_BOARD_VERIFIED',runId,assignmentId:receipt.assignmentId,version:receipt.version,lostAcknowledgementRecovered:true,staleRejected:true,reloaded:true,driverAssignmentVisible:true,priorDriverCompletionVisible:true,durableDispatchUpdate:true}));
}finally{await browser.close();}
