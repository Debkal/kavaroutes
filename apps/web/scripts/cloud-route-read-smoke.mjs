import assert from 'node:assert/strict';
import {chromium} from '@playwright/test';
if(process.env.KAVAROUTES_VERIFY_PRIVATE_CLOUD!=='1')throw new Error('EXPLICIT_PRIVATE_CLOUD_VERIFICATION_REQUIRED');
const browser=await chromium.launch({headless:true});
try{
 const page=await browser.newPage();await page.goto('http://127.0.0.1:4311/dispatch');
 await page.getByRole('heading',{name:'Driver route proposals',exact:true}).waitFor();
 const shift='c2e88496-5850-408a-af3b-fa868bb6ae83';
 const path=`http://127.0.0.1:4311/v1/organizations/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/driver/shifts/${shift}/route-proposals`;
 const driver=await page.request.get(path,{headers:{authorization:'Synthetic principal_driver'}});
 assert.equal(driver.status(),404,'missing planning facts follow the non-disclosing relationship boundary');
 assert.equal((await driver.json()).code,'PERSISTENCE_RELATIONSHIP','persisted route reader ran, not an unpromoted route or local fallback');
 const anonymous=await page.request.get(path);assert.equal(anonymous.status(),401);
 const denied=await page.request.get(path,{headers:{authorization:'Synthetic principal_facility'}});assert.equal(denied.status(),404);
 await page.reload();await page.getByRole('heading',{name:'Driver route proposals',exact:true}).waitFor();
 console.log(JSON.stringify({result:'SOL006_PRIVATE_ROUTE_READ_VERIFIED',missingFactsBlocked:true,unauthorizedDenied:true,reload:true,mutations:0,approvalWorkflow:'local-runtime-verified; cloud full workflow pending signoff and new shift'}));
}finally{await browser.close();}
