import {randomUUID} from 'node:crypto';
import {withTenantTransaction} from '@kavaroutes/postgres-persistence';

const MAX_PENDING=5000;
const BATCH_SIZE=64;
const validName=value=>typeof value==='string'&&/^[A-Z][A-Z0-9_]{0,63}$/.test(value);
const validTenant=value=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);

/** One row per actual network attempt. Cache hits do not enter this log.
 * Bounded batches keep map-tile bursts from creating one database transaction
 * per tile. Never persist the URL, coordinates, key, payload or response. */
export function createProviderUsage(pool,{flushDelayMs=1000}={}){
  const pending=new Map(),dropped=new Map(),failures=new Map(),lastPruneAt=new Map();
  let timer=null,running=null,closed=false,totalPending=0;
  const schedule=()=>{if(timer===null&&!closed){timer=setTimeout(()=>{timer=null;void flush();},flushDelayMs);timer.unref?.();}};
  const dropOldest=()=>{
    let oldestTenant=null,oldestTime=Infinity;
    for(const [id,items] of pending){const time=Date.parse(items[0]?.occurred_at??'');if(time<oldestTime){oldestTenant=id;oldestTime=time;}}
    if(oldestTenant){const items=pending.get(oldestTenant);items.shift();totalPending--;
      dropped.set(oldestTenant,(dropped.get(oldestTenant)??0)+1);if(!items.length)pending.delete(oldestTenant);}
  };
  const record=async({tenantId,provider,operation,feature},request)=>{
    if(!validTenant(tenantId)||![provider,operation,feature].every(validName))throw new Error('INVALID_PROVIDER_USAGE_SCOPE');
    const started=performance.now();let status=0;
    try{
      const response=await request();
      status=Number.isInteger(response?.status)?response.status:response?.ok?200:0;
      return response;
    }finally{
      const row={id:randomUUID(),occurred_at:new Date().toISOString(),provider,operation,feature,
        http_status:Math.max(0,Math.min(599,status)),duration_ms:Math.min(60000,Math.max(0,Math.round(performance.now()-started)))};
      if(totalPending>=MAX_PENDING)dropOldest();
      const queue=pending.get(tenantId)??[];queue.push(row);pending.set(tenantId,queue);totalPending++;
      schedule();
    }
  };
  const flush=async()=>{
    if(running)return running;
    if(timer!==null){clearTimeout(timer);timer=null;}
    running=(async()=>{
      for(const [tenantId,queue] of pending){
        const rows=queue.splice(0,BATCH_SIZE);totalPending-=rows.length;
        if(!rows.length){pending.delete(tenantId);continue;}
        try{
          await withTenantTransaction(pool,tenantId,'kavaroutes_api',async db=>{
            await db.query(`INSERT INTO audit.external_api_request(tenant_id,id,occurred_at,provider,operation,feature,http_status,duration_ms)
              SELECT $1::uuid,x.id,x.occurred_at,x.provider,x.operation,x.feature,x.http_status,x.duration_ms
              FROM jsonb_to_recordset($2::jsonb) AS x(id uuid,occurred_at timestamptz,provider text,operation text,feature text,http_status smallint,duration_ms integer)`,[tenantId,JSON.stringify(rows)]);
            if(Date.now()-(lastPruneAt.get(tenantId)??0)>24*60*60_000){
              await db.query("DELETE FROM audit.external_api_request WHERE tenant_id=$1 AND occurred_at<now()-interval '30 days'",[tenantId]);
              lastPruneAt.set(tenantId,Date.now());
            }
          });
          failures.delete(tenantId);
          if(!queue.length)pending.delete(tenantId);
        }catch{
          queue.unshift(...rows);pending.set(tenantId,queue);totalPending+=rows.length;failures.set(tenantId,new Date().toISOString());
          while(totalPending>MAX_PENDING)dropOldest();
        }
      }
    })();
    try{await running;}finally{running=null;if(pending.size)schedule();}
  };
  const summary=async(tenantId,hours=24)=>{
    if(!validTenant(tenantId)||![1,24,168].includes(hours))throw new Error('INVALID_PROVIDER_USAGE_QUERY');
    await flush();
    const {groups,recent}=await withTenantTransaction(pool,tenantId,'kavaroutes_api',async db=>{
      const since=new Date(Date.now()-hours*3600_000).toISOString();
      const groups=(await db.query(`SELECT provider,operation,feature,count(*)::integer AS count,
        count(*) FILTER (WHERE http_status=0 OR http_status>=400)::integer AS failed,
        round(avg(duration_ms))::integer AS average_ms
        FROM audit.external_api_request WHERE tenant_id=$1 AND occurred_at>=$2::timestamptz
        GROUP BY provider,operation,feature ORDER BY count DESC,provider,operation`,[tenantId,since])).rows;
      const recent=(await db.query(`SELECT occurred_at,provider,operation,feature,http_status,duration_ms
        FROM audit.external_api_request WHERE tenant_id=$1 AND occurred_at>=$2::timestamptz
        ORDER BY occurred_at DESC LIMIT 100`,[tenantId,since])).rows;
      return {groups,recent};
    });
    const normalized=groups.map(row=>({provider:row.provider,operation:row.operation,feature:row.feature,
      count:Number(row.count),failed:Number(row.failed),averageMs:Number(row.average_ms)}));
    const total=normalized.reduce((count,row)=>count+row.count,0);
    return {hours,total,averageRequestsPerHour:Number((total/hours).toFixed(2)),
      averageMs:total?Math.round(normalized.reduce((sum,row)=>sum+row.averageMs*row.count,0)/total):0,
      groups:normalized,recent:recent.map(row=>({at:new Date(row.occurred_at).toISOString(),provider:row.provider,
        operation:row.operation,feature:row.feature,status:Number(row.http_status),durationMs:Number(row.duration_ms)})),
      pendingCount:pending.get(tenantId)?.length??0,droppedCount:dropped.get(tenantId)??0,lastFailureAt:failures.get(tenantId)??null};
  };
  const close=async()=>{closed=true;if(timer!==null)clearTimeout(timer);await flush();};
  return {record,flush,summary,close};
}
