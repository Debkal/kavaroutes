import assert from 'node:assert/strict';
import {chromium} from '@playwright/test';
if(process.env.KAVAROUTES_VERIFY_PRIVATE_CLOUD!=='1'||!['overdue','override','ended'].includes(process.argv[2]))throw new Error('EXPLICIT_SOL007_BROWSER_PHASE_REQUIRED');
const phase=process.argv[2],shift='c2e88496-5850-408a-af3b-fa868bb6ae83',prefix='/v1/organizations/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const browser=await chromium.launch({headless:true});
try{
 const page=await browser.newPage();page.on('dialog',dialog=>dialog.accept());await page.goto('http://127.0.0.1:4311/dispatch');
 await page.getByRole('heading',{name:'Driver transmission status',exact:true}).waitFor();
 const snapshot=await page.request.get(`http://127.0.0.1:4311${prefix}/runtime-dispatch-snapshot?serviceDate=2026-09-14`,{headers:{authorization:'Synthetic principal_dispatcher'}});assert.equal(snapshot.status(),200);
 const shifts=Object.values((await snapshot.json()).projection).filter(r=>r.resourceKind==='driver-shift'),index=shifts.findIndex(r=>r.resourceReference===`driver-shift:${shift}`);assert.ok(index>=0);
 const card=page.locator('article').filter({has:page.getByRole('heading',{name:new RegExp(`^Shift ${index+1}:`)})});
 if(phase==='overdue'){
  await card.getByRole('heading',{name:`Shift ${index+1}: Updates overdue — contact driver`,exact:true}).waitFor();
  await card.getByText('Contact the driver to confirm their status. No automatic call is placed.',{exact:true}).waitFor();
  await page.reload();await card.getByRole('heading',{name:`Shift ${index+1}: Updates overdue — contact driver`,exact:true}).waitFor();
  console.log('SOL007_BROWSER_SILENCE_ALERT_RELOAD_VERIFIED');
 }else if(phase==='override'){
  await card.getByRole('button',{name:'Open synthetic authorized return reviewer',exact:true}).click();
  const approve=card.getByRole('button',{name:'Record audited return override',exact:true});await approve.waitFor();
  let lost=false;
  await page.route('**/commands/override-return',async route=>{if(lost){await route.continue();return;}const response=await route.fetch();assert.equal(response.status(),200);lost=true;await route.abort('failed');});
  await approve.click();await card.getByText(/Outcome unknown. Recover this original request/).waitFor();assert.equal(lost,true);
  await page.reload();await card.getByRole('button',{name:'Open synthetic authorized return reviewer',exact:true}).click();
  await card.getByText('Server confirms this shift has ended. No further override is allowed.',{exact:true}).waitFor();
  assert.equal(await card.getByRole('button',{name:'Record audited return override',exact:true}).isDisabled(),true);
  console.log('SOL007_BROWSER_AUTHORIZED_OVERRIDE_LOST_RESPONSE_RELOAD_VERIFIED');
 }else{
  await card.getByRole('heading',{name:`Shift ${index+1}: Shift ended — collection stopped`,exact:true}).waitFor();
  console.log('SOL007_BROWSER_ACCEPTED_SHIFT_END_VERIFIED');
 }
}finally{await browser.close();}
