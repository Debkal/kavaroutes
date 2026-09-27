import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createGeoapifyDispatchTraceMapService,traceMapRequest} from './dispatch-trace-map.mjs';

const tenant='11111111-1111-4111-8111-111111111111';
const shift='22222222-2222-4222-8222-222222222222';
const client='33333333-3333-4333-8333-333333333333';
const leg='44444444-4444-4444-8444-444444444444';
const day='2026-09-25';
const points=[0,30,180,210].map((seconds,index)=>({latitude:41.88+index*.001,longitude:-87.62-index*.001,
  capturedAt:new Date(Date.parse(`${day}T15:00:00Z`)+seconds*1000).toISOString(),window:index<2?1:2}));

test('street overlay draws recorded segments without bridging a reporting or client gap',()=>{
  const body=traceMapRequest(points);
  assert.equal(body.style,'positron');
  assert.equal(body.geometries.length,2);
  assert.equal(body.geometries[0].type,'polyline5');
  assert.deepEqual(body.markers.map(marker=>marker.text),['S','E']);
  assert.equal(traceMapRequest(points.map(point=>({...point,window:1}))).geometries.length,2);
});

test('trace map reads one tenant shift, filters client actions, keeps the key server-side, and reuses the rendered image',async()=>{
  const queries=[];
  const db={query:async(sql,args)=>{
    queries.push({sql,args});
    if(sql.includes('FROM execution.shift_policy_snapshot'))return {rows:[{id:shift,run_id:'55555555-5555-4555-8555-555555555555'}]};
    if(sql.includes('FROM realtime.location_breadcrumb'))return {rows:[...points].reverse().map(point=>({latitude:point.latitude,longitude:point.longitude,captured_at:point.capturedAt}))};
    if(sql.includes('FROM dispatch.run_leg'))return {rows:[{trip_leg_id:leg}]};
    if(sql.includes('FROM execution.driver_action_receipt'))return {rows:[
      {resource_reference:leg,command_reference:'MARK_EN_ROUTE',captured_at:points[1].capturedAt},
      {resource_reference:leg,command_reference:'COMPLETE_LEG',captured_at:points[2].capturedAt},
    ]};
    return {rows:[]};
  },release(){}};
  const pool={connect:async()=>db};
  let providerCalls=0;
  const fetcher=async(url,options)=>{
    providerCalls++;
    assert.equal(url.searchParams.get('apiKey'),'private-key-123456789012345');
    assert.equal(options.method,'POST');
    const body=JSON.parse(options.body);
    assert.equal(body.markers[0].lat,points[1].latitude);
    assert.equal(body.markers.at(-1).lat,points[2].latitude);
    return {ok:true,headers:{get:()=> 'image/png'},arrayBuffer:async()=>Buffer.from('png')};
  };
  const service=createGeoapifyDispatchTraceMapService(pool,{apiKey:'private-key-123456789012345',fetcher});
  const first=await service({organizationId:tenant,serviceDate:day,shiftId:shift,clientId:client});
  const again=await service({organizationId:tenant,serviceDate:day,shiftId:shift,clientId:client});
  assert.deepEqual(first,again);
  assert.equal(first.fixCount,2);
  assert.equal(first.mapImageUrl,'data:image/png;base64,cG5n');
  assert.equal(JSON.stringify(first).includes('private-key'),false);
  assert.equal(providerCalls,1);
  assert.ok(queries.some(query=>query.sql.includes('receipt.shift_id=$2')&&query.args[0]===tenant&&query.args[1]===shift));
  assert.ok(queries.some(query=>query.sql.includes('scope.facility_id=$3')&&query.args[2]===client));
});

test('a shift missing from the requested service day never reaches the map provider',async()=>{
  const pool={connect:async()=>({query:async(sql)=>({rows:sql.includes('FROM execution.shift_policy_snapshot')?[]:[]}),release(){}})};
  const service=createGeoapifyDispatchTraceMapService(pool,{apiKey:'private-key-123456789012345',fetcher:()=>{throw new Error('unexpected provider request');}});
  await assert.rejects(service({organizationId:tenant,serviceDate:day,shiftId:shift,clientId:null}),{statusCode:404});
});
