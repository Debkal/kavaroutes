import test from 'node:test';
import assert from 'node:assert/strict';
import {createWp007Api} from '../dist/index.js';
test('registered facility schema serializes referenced trip projections without leaking extra fields',async()=>{
 const trip={relatedTripReference:'11111111-1111-4111-8111-111111111111',lifecycle:'COMPLETED',scheduledAt:'2026-09-14T15:00:00.000Z'};
 const page={facilityReference:'30000000-0000-4000-8000-000000000002',serviceDate:'2026-09-14',items:[trip],nextAfter:null};
 const app=await createWp007Api({facilityService:{day:async()=>page,trip:async()=>trip}});
 try{const response=await app.inject({url:'/v1/organizations/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/facility/days/2026-09-14',headers:{authorization:'Synthetic principal_facility'}});assert.equal(response.statusCode,200,response.body);assert.deepEqual(response.json(),page);}finally{await app.close();}
});
test('facility pagination parses only bounded decimal query strings without global coercion',async()=>{
 const received=[];
 const app=await createWp007Api({facilityService:{day:async input=>{received.push(input.limit);return {facilityReference:'30000000-0000-4000-8000-000000000002',serviceDate:input.serviceDate,items:[],nextAfter:null};},trip:async()=>{throw new Error('unused');}}});
 const url='/v1/organizations/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/facility/days/2026-09-14',headers={authorization:'Synthetic principal_facility'};
 try{
  for(const suffix of ['', '?limit=1','?limit=100']){const response=await app.inject({url:url+suffix,headers});assert.equal(response.statusCode,200,response.body);}
  assert.deepEqual(received,[100,1,100]);
  for(const value of ['0','101','-1','1.5','01','NaN','1&limit=2'])assert.equal((await app.inject({url:url+'?limit='+value,headers})).statusCode,400);
  assert.equal(received.length,3,'invalid limits never reach the service');
 }finally{await app.close();}
});
