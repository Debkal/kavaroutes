import {test} from 'node:test';
import assert from 'node:assert/strict';
import {openStore} from '../src/store.mjs';
import {providerUsageView,recordAdminProviderUsage} from '../src/provider-usage.mjs';

const business='11111111-1111-4111-8111-111111111111',tenant='22222222-2222-4222-8222-222222222222';
test('admin request log combines tenant Geoapify calls with business Gmail calls',async()=>{
  const store=openStore(':memory:');
  store.run("INSERT INTO businesses VALUES(?,?,?,'TRIAL','STARTER',1,?,?)",business,'Test Pony','owner@example.test',Date.now(),Date.now());
  store.run('INSERT INTO business_workspaces(business_id,tenant_id) VALUES(?,?)',business,tenant);
  recordAdminProviderUsage(store,{businessId:business,provider:'GOOGLE',operation:'GMAIL_SEND',feature:'ADMIN_EMAIL',status:200,durationMs:20});
  let requested='';
  const fetcher=async url=>{requested=url;return {ok:true,json:async()=>({hours:24,total:2,averageRequestsPerHour:.08,averageMs:10,
    groups:[{provider:'GEOAPIFY',operation:'MAP_TILE',feature:'ROUTE_HISTORY',count:2,failed:0,averageMs:10}],recent:[],
    pendingCount:0,droppedCount:0,lastFailureAt:null})};};
  const result=await providerUsageView(store,business,24,{fetcher});
  assert.match(requested,new RegExp(tenant));
  assert.equal(result.total,3);
  assert.equal(result.groups.find(group=>group.provider==='GOOGLE').count,1);
  assert.equal(result.groups.find(group=>group.provider==='GEOAPIFY').count,2);
  assert.equal(result.recent.length,1);
  await assert.rejects(()=>providerUsageView(store,'33333333-3333-4333-8333-333333333333',24,{fetcher}),error=>error.code==='BUSINESS_WORKSPACE_NOT_FOUND');
  store.close();
});
