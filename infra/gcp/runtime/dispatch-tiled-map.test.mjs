import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createDispatchTiledMapServices,matchingChunks,splitTrace} from './dispatch-tiled-map.mjs';

const tenant='11111111-1111-4111-8111-111111111111',shift='22222222-2222-4222-8222-222222222222';
const day='2026-09-25',client='33333333-3333-4333-8333-333333333333',leg='44444444-4444-4444-8444-444444444444';
const points=Array.from({length:1205},(_,index)=>({latitude:41.88+index*.00003,longitude:-87.62-index*.00003,
  accuracy_meters:3,captured_at:new Date(Date.parse(`${day}T15:00:00Z`)+index*1000).toISOString()}));

test('full trace has no 500-fix crop, respects client actions and separates reporting gaps',async()=>{
  const queries=[];
  const pool={connect:async()=>({query:async(sql,args)=>{
    queries.push({sql,args});
    if(sql.includes('FROM execution.shift_policy_snapshot'))return {rows:[{id:shift,run_id:shift}]};
    if(sql.includes('FROM realtime.location_breadcrumb'))return {rows:points};
    if(sql.includes('FROM dispatch.run_leg'))return {rows:[{trip_leg_id:leg,ordinal:1}]};
    if(sql.includes('FROM execution.driver_action_receipt'))return {rows:[
      {resource_reference:leg,command_reference:'MARK_EN_ROUTE',captured_at:points[100].captured_at},
      {resource_reference:leg,command_reference:'COMPLETE_LEG',captured_at:points[1100].captured_at}]};
    return {rows:[]};
  },release(){}})};
  const services=createDispatchTiledMapServices(pool,{apiKey:'private-key-123456789012345',fetcher:()=>{throw new Error('unexpected');}});
  const full=await services.trace({organizationId:tenant,serviceDate:day,shiftId:shift,clientId:null});
  assert.equal(full.fixCount,1205);
  assert.equal(full.points[0].capturedAt,points[0].captured_at);
  assert.equal(full.points.at(-1).capturedAt,points.at(-1).captured_at);
  assert.equal(full.points[0].window,0);
  assert.equal(full.points[500].window,1);
  assert.equal(full.points.at(-1).window,0);
  assert.ok(queries.some(item=>item.sql.includes('LIMIT $3')&&item.args[2]===100001));
  const scoped=await services.trace({organizationId:tenant,serviceDate:day,shiftId:shift,clientId:client});
  assert.equal(scoped.fixCount,1001);
  assert.equal(scoped.points[0].capturedAt,points[100].captured_at);
  assert.ok(scoped.points.every(point=>point.window===1));
  assert.equal(splitTrace([{...scoped.points[0],window:1},{...scoped.points[1],window:2}]).length,2);
  assert.ok(matchingChunks(full.points).length>=1);
});

test('two legs remain distinct across waiting time in both raw fixes and matched lines',async()=>{
  const secondLeg='55555555-5555-4555-8555-555555555555';
  const pool={connect:async()=>({query:async sql=>({rows:sql.includes('FROM execution.shift_policy_snapshot')?[{id:shift,run_id:shift}]:
    sql.includes('FROM realtime.location_breadcrumb')?points:
    sql.includes('FROM dispatch.run_leg')?[{trip_leg_id:leg,ordinal:1},{trip_leg_id:secondLeg,ordinal:2}]:
    sql.includes('FROM execution.driver_action_receipt')?[
      {resource_reference:leg,command_reference:'MARK_EN_ROUTE',captured_at:points[100].captured_at},
      {resource_reference:leg,command_reference:'COMPLETE_LEG',captured_at:points[300].captured_at},
      {resource_reference:secondLeg,command_reference:'MARK_EN_ROUTE',captured_at:points[800].captured_at},
      {resource_reference:secondLeg,command_reference:'COMPLETE_LEG',captured_at:points[1100].captured_at}]:[]}),release(){}})};
  const fetcher=async()=>({ok:true,json:async()=>({features:[{geometry:{coordinates:[[[ -87.62,41.88],[-87.621,41.881]]]}}]})});
  const services=createDispatchTiledMapServices(pool,{apiKey:'private-key-123456789012345',fetcher});
  const input={organizationId:tenant,serviceDate:day,shiftId:shift,clientId:null};
  const trace=await services.trace(input);
  assert.deepEqual([trace.points[200].window,trace.points[500].window,trace.points[900].window],[1,0,2]);
  assert.equal((await services.match(input)).status,'PENDING');
  await new Promise(resolve=>setImmediate(resolve));
  const matched=await services.match(input);
  assert.equal(matched.status,'READY');
  assert.deepEqual([...new Set(matched.windows)],[0,1,2]);
  assert.equal(matched.windows.length,matched.segments.length);
});

test('map tiles and matched geometry stay behind the authorized service and reuse cached work',async()=>{
  const calls=[];
  let databaseReads=0;
  const pool={connect:async()=>({query:async sql=>{databaseReads++;return {rows:sql.includes('FROM execution.shift_policy_snapshot')?[{id:shift,run_id:shift}]:
    sql.includes('FROM realtime.location_breadcrumb')?points.slice(0,5):[]};},release(){}})};
  const fetcher=async(url,options)=>{
    calls.push({url:String(url),options});
    if(String(url).includes('/tile/'))return {ok:true,headers:{get:()=> 'image/png'},arrayBuffer:async()=>Buffer.from('png')};
    return {ok:true,json:async()=>({features:[{geometry:{coordinates:[[[...[-87.62,41.88]],[-87.621,41.881]]]}}]})};
  };
  const services=createDispatchTiledMapServices(pool,{apiKey:'private-key-123456789012345',fetcher});
  const first=await services.tile({z:12,x:1048,y:1522});
  assert.equal(first.imageUrl,'data:image/png;base64,cG5n');
  assert.deepEqual(await services.tile({z:12,x:1048,y:1522}),first);
  assert.equal(calls.length,1);
  const batch=await services.tileBatch({tiles:[{z:12,x:1048,y:1522},{z:12,x:1049,y:1522},{z:12,x:1049,y:1522}]});
  assert.equal(batch.tiles.length,3);
  assert.ok(batch.tiles.every(item=>item.imageUrl===first.imageUrl));
  assert.equal(calls.length,2,'the batch reuses both cached and in-flight tile work');
  const input={organizationId:tenant,serviceDate:day,shiftId:shift,clientId:null};
  assert.equal((await services.match(input)).status,'PENDING');
  const readsAfterStart=databaseReads;
  await new Promise(resolve=>setImmediate(resolve));
  const ready=await services.match(input);
  assert.equal(ready.status,'READY');
  assert.ok(ready.segments.length);
  assert.equal(ready.windows.length,ready.segments.length);
  assert.equal(JSON.stringify(ready).includes('private-key'),false);
  assert.equal(calls.filter(call=>call.url.includes('/mapmatching')).length,1);
  assert.equal(databaseReads,readsAfterStart,'match status polling reuses geometry without rereading GPS');
});

test('tile batches cap provider concurrency and reuse the shared tile cache',async()=>{
  let active=0,peak=0,calls=0;
  const fetcher=async()=>{
    calls++;active++;peak=Math.max(peak,active);
    await new Promise(resolve=>setTimeout(resolve,2));
    active--;
    return {ok:true,headers:{get:()=> 'image/png'},arrayBuffer:async()=>Buffer.from('png')};
  };
  const services=createDispatchTiledMapServices(null,{apiKey:'private-key-123456789012345',fetcher});
  const tiles=Array.from({length:20},(_,index)=>({z:12,x:1000+index,y:1500}));
  const first=await services.tileBatch({tiles});
  assert.equal(first.tiles.length,20);
  assert.ok(peak<=6);
  assert.equal(calls,20);
  assert.deepEqual(await services.tileBatch({tiles}),first);
  assert.equal(calls,20,'a second viewport request does not call the provider again');
});
