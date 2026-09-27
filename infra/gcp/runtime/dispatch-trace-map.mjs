import {createHash} from 'node:crypto';
import {withTenantTransaction} from '@kavaroutes/postgres-persistence';
import {RoadRoutingError} from '@kavaroutes/api-contracts';
import {roadRoutingInternals} from './road-routing.mjs';

const STATIC_MAP_URL='https://maps.geoapify.com/v1/staticmap';
const GAP_MS=90_000;
const coord=point=>[Number(point.latitude),Number(point.longitude)];
const validPoint=point=>Number.isFinite(point.latitude)&&Math.abs(point.latitude)<=90&&Number.isFinite(point.longitude)&&Math.abs(point.longitude)<=180&&Number.isFinite(Date.parse(point.capturedAt));

/** The map draws only observed travel. A long reporting gap or another client's
 * leg starts a new line; neither becomes a fictitious street segment. */
export function traceMapRequest(points){
  if(!points.length||points.length>500||points.some(point=>!validPoint(point)))throw new Error('INVALID_TRACE_POINTS');
  const segments=[];
  for(const point of points){
    const current=segments.at(-1);
    const previous=current?.at(-1);
    if(!previous||point.window!==previous.window||Date.parse(point.capturedAt)-Date.parse(previous.capturedAt)>GAP_MS)segments.push([]);
    segments.at(-1).push(point);
  }
  const geometries=segments.filter(segment=>segment.length>1).map(segment=>({
    type:'polyline5',value:roadRoutingInternals.encodePolyline(segment.map(coord)),
    linecolor:'#17637c',linewidth:5,lineopacity:0.96,
  }));
  const first=points[0],last=points.at(-1);
  const markers=[{lat:first.latitude,lon:first.longitude,type:'circle',color:'#2e7658',size:30,text:'S'}];
  if(points.length>1)markers.push({lat:last.latitude,lon:last.longitude,type:'circle',color:'#af6546',size:30,text:'E'});
  for(const segment of segments.filter(item=>item.length===1).slice(0,20)){
    const point=segment[0];
    if(point!==first&&point!==last)markers.push({lat:point.latitude,lon:point.longitude,type:'circle',color:'#17637c',size:12});
  }
  return {style:'positron',width:900,height:500,format:'png',attribution:'default',geometries,markers};
}

async function renderTraceMap(fetcher,apiKey,points){
  const url=new URL(STATIC_MAP_URL);url.searchParams.set('apiKey',apiKey);
  let response;
  try{response=await fetcher(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(traceMapRequest(points)),signal:AbortSignal.timeout(12000)});}
  catch{return null;}
  if(!response.ok||!String(response.headers?.get('content-type')??'').startsWith('image/png'))return null;
  try{const bytes=Buffer.from(await response.arrayBuffer());return bytes.length>0&&bytes.length<=900000?`data:image/png;base64,${bytes.toString('base64')}`:null;}
  catch{return null;}
}

/** Keep the provider key on the API host. The request is bound to a recorded shift,
 * and client filtering is derived from that run's trip legs and applied actions. */
export function createGeoapifyDispatchTraceMapService(pool,{apiKey=null,fetcher=fetch}={}){
  const configured=typeof apiKey==='string'&&/^[A-Za-z0-9_-]{20,200}$/.test(apiKey);
  const cache=new Map();
  return async({organizationId,serviceDate,shiftId,clientId})=>{
    if(!configured)throw new RoadRoutingError(503,'MAPS_NOT_CONFIGURED');
    const points=await withTenantTransaction(pool,organizationId,'kavaroutes_api',async db=>{
      const shift=(await db.query(`SELECT s.id,a.run_id FROM execution.shift_policy_snapshot s
        JOIN dispatch.assignment a ON a.tenant_id=s.tenant_id AND a.id=s.assignment_id
        JOIN dispatch.run r ON r.tenant_id=a.tenant_id AND r.id=a.run_id
        WHERE s.tenant_id=$1 AND s.id=$2 AND r.service_date=$3::date AND s.lifecycle IN ('ACTIVE','SHIFT_ENDED') LIMIT 1`,
        [organizationId,shiftId,serviceDate])).rows[0];
      if(!shift)throw new RoadRoutingError(404,'RESOURCE_NOT_FOUND');
      const rows=(await db.query(`SELECT ST_Y(b.position::geometry) AS latitude,ST_X(b.position::geometry) AS longitude,b.captured_at
        FROM realtime.location_breadcrumb b JOIN realtime.location_batch_receipt receipt ON receipt.tenant_id=b.tenant_id AND receipt.id=b.batch_id
        WHERE b.tenant_id=$1 AND receipt.shift_id=$2 ORDER BY b.captured_at DESC,b.id DESC LIMIT 500`,[organizationId,shiftId])).rows.reverse();
      const trace=rows.map(row=>({latitude:Number(row.latitude),longitude:Number(row.longitude),capturedAt:new Date(row.captured_at).toISOString(),window:0}));
      if(!clientId)return trace;
      const legs=(await db.query(`SELECT rl.trip_leg_id FROM dispatch.run_leg rl
        JOIN intake.trip_leg leg ON leg.tenant_id=rl.tenant_id AND leg.id=rl.trip_leg_id
        JOIN intake.facility_trip_scope scope ON scope.tenant_id=leg.tenant_id AND scope.trip_id=leg.trip_request_id
        WHERE rl.tenant_id=$1 AND rl.run_id=$2 AND scope.facility_id=$3`,
        [organizationId,shift.run_id,clientId])).rows.map(row=>String(row.trip_leg_id));
      if(!legs.length)throw new RoadRoutingError(404,'RESOURCE_NOT_FOUND');
      const actions=(await db.query(`SELECT resource_reference,command_reference,captured_at
        FROM execution.driver_action_receipt WHERE tenant_id=$1 AND shift_id=$2 AND resource_reference=ANY($3::uuid[]) AND outcome='APPLIED'
        ORDER BY captured_at`,[organizationId,shiftId,legs])).rows;
      const intervals=legs.flatMap((legId,index)=>{
        const events=actions.filter(action=>String(action.resource_reference)===legId);
        const start=events.find(action=>['MARK_EN_ROUTE','ARRIVE_PICKUP','BOARD_RIDER'].includes(action.command_reference));
        const end=events.find(action=>['COMPLETE_LEG','MARK_RIDER_NO_SHOW'].includes(action.command_reference));
        return start?[{from:new Date(start.captured_at).getTime(),to:new Date(end?.captured_at??trace.at(-1)?.capturedAt??start.captured_at).getTime(),window:index+1}]:[];
      });
      return trace.flatMap(point=>{
        const instant=Date.parse(point.capturedAt);
        const window=intervals.find(interval=>instant>=interval.from&&instant<=interval.to);
        return window?[{...point,window:window.window}]:[];
      });
    });
    if(!points.length)return {shiftReference:shiftId,serviceDate,clientId,fixCount:0,mapImageUrl:null};
    const fingerprint=createHash('sha256').update(JSON.stringify(points)).digest('hex');
    const key=`${organizationId}|${serviceDate}|${shiftId}|${clientId??''}|${fingerprint}`;
    const cached=cache.get(key);
    if(cached&&cached.expires>Date.now())return {shiftReference:shiftId,serviceDate,clientId,fixCount:points.length,mapImageUrl:cached.image};
    if(cache.size>=20)cache.delete(cache.keys().next().value);
    const image=await renderTraceMap(fetcher,apiKey,points);
    if(image)cache.set(key,{image,expires:Date.now()+30*60_000});
    return {shiftReference:shiftId,serviceDate,clientId,fixCount:points.length,mapImageUrl:image};
  };
}
