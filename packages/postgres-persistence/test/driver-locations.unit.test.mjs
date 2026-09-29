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
