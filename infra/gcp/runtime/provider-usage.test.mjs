import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createProviderUsage} from './provider-usage.mjs';

const tenant='11111111-1111-4111-8111-111111111111';
test('outbound attempts are batched and retain only safe metadata',async()=>{
  const queries=[];
  const pool={connect:async()=>({query:async(sql,args)=>{
    queries.push({sql,args});
    if(sql.includes('GROUP BY provider'))return {rows:[{provider:'GEOAPIFY',operation:'MAP_TILE',feature:'ROUTE_HISTORY',count:3,failed:2,average_ms:8}]};
    if(sql.includes('ORDER BY occurred_at DESC LIMIT 100'))return {rows:[]};
    return {rows:[]};
  },release(){}})};
  const usage=createProviderUsage(pool,{flushDelayMs:100000});
  const scope={tenantId:tenant,provider:'GEOAPIFY',operation:'MAP_TILE',feature:'ROUTE_HISTORY'};
  await usage.record(scope,async()=>({ok:true,status:200}));
  await usage.record(scope,async()=>({ok:false,status:503}));
  await assert.rejects(()=>usage.record(scope,async()=>{throw new Error('secret-key-was-in-the-url');}));
  await usage.flush();
  const writes=queries.filter(query=>query.sql.includes('INSERT INTO audit.external_api_request'));
  assert.equal(writes.length,1,'three provider calls share one database write');
  const payload=JSON.parse(writes[0].args[1]);
  assert.deepEqual(payload.map(row=>row.http_status),[200,503,0]);
  assert.equal(JSON.stringify(payload).includes('secret-key'),false);
  const view=await usage.summary(tenant,1);
  assert.equal(view.total,3);
  assert.equal(view.averageRequestsPerHour,3);
  assert.equal(view.pendingCount,0);
  await usage.close();
});
