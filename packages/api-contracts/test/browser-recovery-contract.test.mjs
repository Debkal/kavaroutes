import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createWp007Api} from '../dist/index.js';
test('browser command envelope references validate without weakening closed request fields',async()=>{
 const id=randomUUID(),envelope={kind:'ASSIGN_RUN',resourceId:randomUUID(),expectedTag:'"kr1.'+'A'.repeat(43)+'"',body:{driverId:randomUUID(),vehicleId:randomUUID(),expectedVersion:1}};
 let calls=0;
 const app=await createWp007Api({browserRecoveryService:{prepare:async(_context,input)=>{calls++;return {...input,result:null,expired:false,acknowledged:false};}}});
 const request={method:'POST',url:'/v1/organizations/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/browser-commands',headers:{authorization:'Synthetic principal_dispatcher','idempotency-key':`browser-prepare-${id}`}};
 try{
  const response=await app.inject({...request,payload:{id,envelope}});assert.equal(response.statusCode,200,response.body);assert.deepEqual(response.json().envelope,envelope);
  assert.equal((await app.inject({...request,payload:{id,envelope:{...envelope,url:'https://invalid.test'}}})).statusCode,400);
  assert.equal((await app.inject({...request,payload:{id,envelope:{...envelope,body:{...envelope.body,expectedVersion:'1'}}}})).statusCode,400);
  assert.equal(calls,1);
 }finally{await app.close();}
});
