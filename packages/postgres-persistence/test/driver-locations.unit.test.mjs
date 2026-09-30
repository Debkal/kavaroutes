import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test from 'node:test';
import {recordDeviceLocations} from '../dist/driver-locations.js';

test('mixed location batches replay the saved and rejected outcomes without duplicating fixes',async()=>{
  const tenantId=randomUUID(),shiftId=randomUUID(),generation=randomUUID(),deviceId=randomUUID();
  const valid={sampleId:randomUUID(),sequence:1,capturedAt:new Date().toISOString(),latitude:41.8,longitude:-87.6,accuracyMeters:10};
  const expired={sampleId:randomUUID(),sequence:2,capturedAt:new Date(Date.now()-60*60_000).toISOString(),latitude:41.8,longitude:-87.6,accuracyMeters:10};
  const input={shiftId,generation,deviceId,batchReference:randomUUID(),samples:[valid,expired]};
  let receipt=null,insertions=0;
  const db={query:async(sql,params)=>{
    if(sql.includes('FROM execution.shift_policy_snapshot')&&sql.includes('FOR UPDATE'))return {rows:[{driver_id:randomUUID(),lifecycle:'ACTIVE',shift_generation:generation,collection_stopped:false,pinned_at:new Date(Date.now()-60_000)}]};
    if(sql.includes('SELECT id,sample_count FROM realtime.location_batch_receipt'))return {rows:receipt?[receipt]:[]};
    if(sql.startsWith('INSERT INTO realtime.location_batch_receipt')){receipt={id:params[1],sample_count:params[4]};return {rows:[]};}
    if(sql.startsWith('INSERT INTO realtime.location_breadcrumb')){insertions++;return {rows:[]};}
    if(sql.includes('SELECT id FROM realtime.location_breadcrumb'))return {rows:[{id:valid.sampleId}]};
    return {rows:[]};
  }};
  const first=await recordDeviceLocations(db,tenantId,input);
  assert.deepEqual(first.map(item=>item.outcome),['APPLIED','REJECTED']);
  assert.equal(receipt.sample_count,2);
  const replay=await recordDeviceLocations(db,tenantId,input);
  assert.deepEqual(replay.map(item=>item.outcome),['REPLAYED','REJECTED']);
  receipt.sample_count=1; // Existing deployments stored only the accepted sample count.
  assert.deepEqual((await recordDeviceLocations(db,tenantId,input)).map(item=>item.outcome),['REPLAYED','REJECTED']);
  assert.equal(insertions,1);
});

test('an entirely rejected batch still has an auditable receipt',async()=>{
  const generation=randomUUID();
  const input={shiftId:randomUUID(),generation,deviceId:randomUUID(),batchReference:randomUUID(),
    samples:[{sampleId:randomUUID(),sequence:1,capturedAt:new Date(Date.now()-60*60_000).toISOString(),latitude:41.8,longitude:-87.6}]};
  let receiptCount=null;
  const db={query:async(sql,params)=>{
    if(sql.includes('FROM execution.shift_policy_snapshot')&&sql.includes('FOR UPDATE'))return {rows:[{driver_id:randomUUID(),lifecycle:'ACTIVE',shift_generation:generation,collection_stopped:false,pinned_at:new Date(Date.now()-60_000)}]};
    if(sql.includes('SELECT id,sample_count FROM realtime.location_batch_receipt'))return {rows:[]};
    if(sql.startsWith('INSERT INTO realtime.location_batch_receipt'))receiptCount=params[4];
    if(sql.startsWith('INSERT INTO realtime.location_breadcrumb'))assert.fail('expired fix must not be saved');
    return {rows:[]};
  }};
  const result=await recordDeviceLocations(db,randomUUID(),input);
  assert.equal(result[0].outcome,'REJECTED');
  assert.equal(receiptCount,1);
});

test('a long offline Driver shift retains delayed fixes within 24 hours',async()=>{
  const generation=randomUUID(),now=Date.now();
  const recent={sampleId:randomUUID(),sequence:1,capturedAt:new Date(now-2*60*60_000).toISOString(),latitude:41.8,longitude:-87.6};
  const tooOld={sampleId:randomUUID(),sequence:2,capturedAt:new Date(now-25*60*60_000).toISOString(),latitude:41.9,longitude:-87.7};
  let saved=0;
  const db={query:async sql=>{
    if(sql.includes('FROM execution.shift_policy_snapshot')&&sql.includes('FOR UPDATE'))return {rows:[{driver_id:randomUUID(),lifecycle:'ACTIVE',shift_generation:generation,collection_stopped:false,pinned_at:new Date(now-26*60*60_000)}]};
    if(sql.includes('SELECT id,sample_count FROM realtime.location_batch_receipt'))return {rows:[]};
    if(sql.startsWith('INSERT INTO realtime.location_breadcrumb'))saved++;
    return {rows:[]};
  }};
  const result=await recordDeviceLocations(db,randomUUID(),{shiftId:randomUUID(),generation,deviceId:randomUUID(),batchReference:randomUUID(),samples:[recent,tooOld]});
  assert.deepEqual(result.map(item=>item.outcome),['APPLIED','REJECTED']);
  assert.equal(saved,1);
});

test('tracking batches traces in two data queries, keeps empty shifts and binds the tenant',async()=>{
  const {createDispatchTrackingReader}=await import('../dist/driver-locations.js');
  const tenant=randomUUID(),first=randomUUID(),second=randomUUID(),queries=[];
  const row=id=>({id,driver_id:randomUUID(),driver_label:'Driver',lifecycle:'SHIFT_ENDED',collection_stopped:true,
    pinned_at:new Date('2026-09-25T15:00:00Z'),planned_start_at:new Date('2026-09-25T15:00:00Z'),service_timezone:'America/Chicago',vehicle_label:null});
  let released=false;
  const db={query:async(sql,params)=>{
    queries.push({sql,params});
    if(sql.includes('FROM execution.shift_policy_snapshot'))return {rows:[row(first),row(second)]};
    if(sql.includes('FROM unnest'))return {rows:[
      {shift_id:first,latitude:41.8,longitude:-87.6,accuracy_meters:10,captured_at:new Date('2026-09-25T15:01:00Z')},
      {shift_id:first,latitude:41.9,longitude:-87.7,accuracy_meters:null,captured_at:new Date('2026-09-25T15:02:00Z')}]};
    return {rows:[]};
  },release:()=>{released=true;}};
  const result=await createDispatchTrackingReader({connect:async()=>db})(tenant,'2026-09-25');
  const dataQueries=queries.filter(item=>item.sql.includes('FROM execution.shift_policy_snapshot')||item.sql.includes('FROM unnest'));
  assert.equal(dataQueries.length,2);
  assert.deepEqual(dataQueries[1].params,[tenant,[first,second]]);
  assert.match(dataQueries[1].sql,/b\.tenant_id=\$1/);
  assert.match(dataQueries[1].sql,/LIMIT 500/);
  assert.equal(result.shifts.length,2);
  assert.equal(result.shifts[0].trace.length,2);
  assert.equal(result.shifts[0].position.capturedAt,'2026-09-25T15:02:00.000Z');
  assert.deepEqual(result.shifts[1].trace,[]);
  assert.equal(result.shifts[1].position,null);
  assert.equal(released,true);
});
