const fail=(status,code)=>{throw Object.assign(new Error(code),{status,code});};
const validId=value=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
export function initProviderUsage(store){store.db.exec(`CREATE TABLE IF NOT EXISTS external_api_request(
  id INTEGER PRIMARY KEY,business_id TEXT NOT NULL REFERENCES businesses(id),at INTEGER NOT NULL,
  provider TEXT NOT NULL,operation TEXT NOT NULL,feature TEXT NOT NULL,status INTEGER NOT NULL,duration_ms INTEGER NOT NULL);
  CREATE INDEX IF NOT EXISTS external_api_request_recent ON external_api_request(business_id,at DESC);`);}
export function recordAdminProviderUsage(store,{businessId,provider,operation,feature,status,durationMs}){
  if(!validId(businessId)||![provider,operation,feature].every(value=>typeof value==='string'&&/^[A-Z][A-Z0-9_]{0,63}$/.test(value))||
    !Number.isInteger(status)||status<0||status>599||!Number.isInteger(durationMs)||durationMs<0||durationMs>60000)return;
  const now=Date.now();
  store.run('INSERT INTO external_api_request(business_id,at,provider,operation,feature,status,duration_ms) VALUES(?,?,?,?,?,?,?)',
    businessId,now,provider,operation,feature,status,durationMs);
  store.run('DELETE FROM external_api_request WHERE at<?',now-30*86400_000);
}

/** This localhost-only bridge is called after the platform owner's admin
 * session is verified. The tenant always comes from the linked workspace. */
export async function providerUsageView(store,businessId,hours,{fetcher=fetch}={}){
  if(!validId(businessId)||![1,24,168].includes(hours))fail(400,'INVALID_PROVIDER_USAGE_QUERY');
  const linked=store.get(`SELECT b.id,b.name,w.tenant_id FROM businesses b JOIN business_workspaces w
    ON w.business_id=b.id WHERE b.id=?`,businessId);
  if(!linked||!validId(linked.tenant_id))fail(404,'BUSINESS_WORKSPACE_NOT_FOUND');
  let response;
  try{response=await fetcher(`http://127.0.0.1:58082/v1/organizations/${linked.tenant_id}/dispatch/provider-usage?hours=${hours}`,
    {headers:{authorization:'Synthetic principal_dispatcher',accept:'application/json'},signal:AbortSignal.timeout(10000),redirect:'error'});}
  catch{fail(503,'PROVIDER_USAGE_UNAVAILABLE');}
  if(!response.ok)fail(503,'PROVIDER_USAGE_UNAVAILABLE');
  let value;try{value=await response.json();}catch{fail(503,'PROVIDER_USAGE_UNAVAILABLE');}
  if(value?.hours!==hours||!Number.isSafeInteger(value.total)||!Array.isArray(value.groups)||value.groups.length>500||
    !Array.isArray(value.recent)||value.recent.length>100)fail(503,'PROVIDER_USAGE_UNAVAILABLE');
  const since=Date.now()-hours*3600_000;
  const adminRows=store.all(`SELECT provider,operation,feature,status,duration_ms,at FROM external_api_request
    WHERE business_id=? AND at>=? ORDER BY at DESC LIMIT 5000`,linked.id,since);
  const grouped=new Map();
  for(const group of value.groups){grouped.set(`${group.provider}|${group.operation}|${group.feature}`,{...group});}
  for(const row of adminRows){
    const key=`${row.provider}|${row.operation}|${row.feature}`;
    const group=grouped.get(key)??{provider:row.provider,operation:row.operation,feature:row.feature,count:0,failed:0,averageMs:0};
    group.averageMs=Math.round((group.averageMs*group.count+row.duration_ms)/(group.count+1));
    group.count++;if(row.status===0||row.status>=400)group.failed++;
    grouped.set(key,group);
  }
  const groups=[...grouped.values()].sort((a,b)=>b.count-a.count||a.provider.localeCompare(b.provider));
  const total=groups.reduce((sum,row)=>sum+row.count,0);
  const recent=[...value.recent,...adminRows.map(row=>({at:new Date(row.at).toISOString(),provider:row.provider,
    operation:row.operation,feature:row.feature,status:row.status,durationMs:row.duration_ms}))]
    .sort((a,b)=>Date.parse(b.at)-Date.parse(a.at)).slice(0,100);
  return {businessId:linked.id,businessName:linked.name,...value,groups,recent,total,
    averageRequestsPerHour:Number((total/hours).toFixed(2)),
    averageMs:total?Math.round(groups.reduce((sum,row)=>sum+row.averageMs*row.count,0)/total):0};
}
