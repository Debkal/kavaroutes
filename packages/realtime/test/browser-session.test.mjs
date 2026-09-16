import assert from 'node:assert/strict';
import test from 'node:test';
import {createRealtimeGateway} from '../dist/gateway.js';
import {createSyntheticTestVerifier} from '@kavaroutes/api-contracts';
import {createAuthorizationGenerationSource,REALTIME_PROTOCOL} from '../dist/index.js';

async function setup(store){
  const synthetic=await createSyntheticTestVerifier().verify('Synthetic principal_dispatcher');
  const principal={...synthetic,kind:'BROWSER_USER'},frames=[],closed=[];
  const gateway=createRealtimeGateway({store:store??{replay:async()=>assert.fail('revoked session cannot reach store')},
    generationSource:createAuthorizationGenerationSource(),allowedOrigins:new Set(['https://app.kavaroutes.com'])});
  const input={principal,origin:'https://app.kavaroutes.com',protocol:REALTIME_PROTOCOL,
    transport:{bufferedAmount:0,send:frame=>frames.push(JSON.parse(frame)),ping(){},close:code=>closed.push(code),terminate(){}}};
  return{gateway,input,frames,closed};
}
test('browser connections require a session revalidator and retain origin enforcement',async()=>{
  const f=await setup();
  assert.throws(()=>f.gateway.open(f.input));
  assert.throws(()=>f.gateway.open({...f.input,origin:undefined,revalidateSession:async()=>true}));
  assert.equal(f.gateway.activeConnections(),0);
});
test('revocation during replay suppresses the awaited batch and live acknowledgement',async()=>{
  let valid=true,replays=0;
  const f=await setup({replay:async()=>{replays++;valid=false;return{outcome:'REPLAY',cursor:'opaque',changes:[{}]};}});
  const id=f.gateway.open({...f.input,revalidateSession:async()=>valid});
  await f.gateway.receive(id,JSON.stringify({type:'subscription.subscribe',messageId:'message:synthetic:001',subscriptionId:'subscription:synthetic:001',
    organizationId:f.input.principal.organizationId,purpose:'DISPATCH_CONTROL',
    scope:{streamKind:'DISPATCH_DAY',scopeReference:'branch:synthetic-all',serviceDate:'2026-08-25'},cursor:'rtc1.'+'x'.repeat(100)}));
  assert.equal(replays,1);assert.equal(f.gateway.activeConnections(),0);
  assert.deepEqual(f.frames.map(frame=>frame.type),['connection.ready']);
});
test('idle browser connection is closed by session sweep after revocation',async()=>{
  const f=await setup();let valid=true;
  f.gateway.open({...f.input,revalidateSession:async()=>valid});
  await f.gateway.sessionSweep();assert.equal(f.gateway.activeConnections(),1);
  valid=false;await f.gateway.sessionSweep();assert.equal(f.gateway.activeConnections(),0);
  assert.equal(f.closed.length,1);assert.equal(f.frames.length,1);
});
test('receive and fanout fail closed on session lookup failure before business work',async()=>{
  for(const operation of ['receive','fanOut']){
    const f=await setup();const id=f.gateway.open({...f.input,revalidateSession:async()=>{throw new Error('SECRET_CANARY');}});
    if(operation==='receive')await f.gateway.receive(id,'{}');else await f.gateway.fanOut();
    assert.equal(f.gateway.activeConnections(),0);assert.equal(f.closed.length,1);
    assert.ok(!JSON.stringify(f.frames).includes('SECRET_CANARY'));
  }
});
