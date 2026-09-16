import assert from 'node:assert/strict';
import {chromium} from '@playwright/test';
if(process.env.KAVAROUTES_VERIFY_PRIVATE_CLOUD!=='1')throw new Error('EXPLICIT_PRIVATE_CLOUD_OPT_IN_REQUIRED');
const base='http://127.0.0.1:4311',prefix='/v1/organizations/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/facility';
const browser=await chromium.launch({headless:true});
try{
 const page=await browser.newPage({viewport:{width:390,height:844}}),requests=[];
 await page.goto(base+'/dispatch');
 await page.getByRole('heading',{name:'Driver transmission status',exact:true}).waitFor();
 // Dispatch may legitimately poll before navigation commits. Record requests
 // only once the browser has entered the facility route, including its load.
 page.on('request',request=>{if(new URL(page.url()).pathname==='/facility'&&request.url().includes('/v1/'))requests.push(new URL(request.url()).pathname);});
 await page.getByRole('link',{name:/Facility/}).click();
 await page.getByRole('heading',{name:'Facility arrivals',exact:true}).waitFor();
 await page.getByRole('button',{name:'View trip 1',exact:true}).waitFor();
 await page.getByRole('button',{name:'View trip 1',exact:true}).click();
 await page.getByRole('region',{name:'Selected facility trip'}).getByText(/COMPLETED/).waitFor();
 await page.waitForTimeout(5500); // Cross the previous dispatch poll interval.
 assert.equal(requests.some(path=>path.includes('runtime-dispatch')||path.includes('/driver/')||path.includes('/dispatch/')),false,JSON.stringify(requests));
 const headers={authorization:'Synthetic principal_facility'};
 const response=await page.request.get(base+prefix+'/days/2026-09-14?limit=1',{headers});assert.equal(response.status(),200);
 const first=await response.json();assert.equal(first.items.length,1);assert.ok(first.nextAfter);
 assert.deepEqual(Object.keys(first.items[0]).sort(),['lifecycle','relatedTripReference','scheduledAt']);
 const next=await page.request.get(base+prefix+'/days/2026-09-14?limit=1&after='+first.nextAfter,{headers});assert.equal(next.status(),200);
 const second=await next.json();assert.equal(second.items.length,1);assert.equal(second.nextAfter,null);
 assert.deepEqual([...first.items,...second.items].map(t=>t.relatedTripReference).sort(),['32000000-0000-4000-8000-000000000004','35000000-0000-4000-8000-000000000004']);
 for(const persona of ['principal_dispatcher','principal_driver','principal_outsider'])assert.equal((await page.request.get(base+prefix+'/days/2026-09-14',{headers:{authorization:'Synthetic '+persona}})).status(),404);
 assert.equal((await page.request.get(base+prefix+'/trips/11111111-1111-4111-8111-111111111111',{headers})).status(),404);
 await page.reload();await page.getByRole('button',{name:'View trip 1',exact:true}).waitFor();
 await page.route('**/facility/days/**',route=>route.fulfill({status:503,contentType:'application/problem+json',body:JSON.stringify({status:503,code:'SYNTHETIC_TEST_UNAVAILABLE'})}));
 await page.getByRole('button',{name:'Refresh facility trips',exact:true}).click();
 await page.getByRole('alert').filter({hasText:'Facility trips unavailable'}).waitFor();assert.equal(await page.getByRole('button',{name:'View trip 1',exact:true}).count(),0);
 await page.unroute('**/facility/days/**');await page.getByRole('button',{name:'Refresh facility trips',exact:true}).click();await page.getByRole('button',{name:'View trip 1',exact:true}).waitFor();
 await page.route('**/v1/me',route=>route.fulfill({status:401,contentType:'application/problem+json',body:JSON.stringify({status:401,code:'SYNTHETIC_TEST_REVOKED'})}));
 await page.reload();await page.getByRole('alert').filter({hasText:'Facility session unavailable'}).waitFor();assert.equal(await page.getByRole('button',{name:'View trip 1',exact:true}).count(),0);
 console.log('SOL008_PRIVATE_FACILITY_SCOPE_PAGINATION_RELOAD_NARROW_RECOVERY_VERIFIED');
}finally{await browser.close();}
