import test from 'node:test';
import assert from 'node:assert/strict';
import {createWp007Api} from '../dist/index.js';
test('trip list accepts bounded URL limits and rejects ambiguous coercion',async()=>{
 const seen=[],app=await createWp007Api({application:{listTrips:async(_organization,input)=>{seen.push(input.limit);return [];}}});
 const url='/v1/organizations/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/trips',headers={authorization:'Synthetic principal_dispatcher'};
 try{
  for(const suffix of ['', '?limit=1','?limit=50','?limit=200']){const r=await app.inject({url:url+suffix,headers});assert.equal(r.statusCode,200,r.body);}
  assert.deepEqual(seen,[50,1,50,200]);
  for(const value of ['0','201','-1','1.5','01','NaN','1&limit=2'])assert.equal((await app.inject({url:url+'?limit='+value,headers})).statusCode,400);
  assert.equal(seen.length,4);
 }finally{await app.close();}
});
