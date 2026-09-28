import {withTenantTransaction} from '@kavaroutes/postgres-persistence';
import {RoadRoutingError} from '@kavaroutes/api-contracts';

const MAX_FIXES=100000;
const GAP_MS=90000;
const MATCH_URL='https://api.geoapify.com/v1/mapmatching';
const TILE_ROOT='https://maps.geoapify.com/v1/tile/positron';
const validKey=key=>typeof key==='string'&&/^[A-Za-z0-9_-]{20,200}$/.test(key);
const position=row=>({latitude:Number(row.latitude),longitude:Number(row.longitude),accuracyMeters:row.accuracy_meters===null?null:Number(row.accuracy_meters),capturedAt:new Date(row.captured_at).toISOString(),window:0});

/** Read all retained fixes for one authorized shift; the day-wide tracking list
 * remains bounded, but a selected history must not silently drop its first 88%. */
export async function readDispatchTrace(pool,{organizationId,serviceDate,shiftId,clientId=null}){
  return withTenantTransaction(pool,organizationId,'kavaroutes_api',async db=>{
    const shift=(await db.query(`SELECT s.id,a.run_id FROM execution.shift_policy_snapshot s
      JOIN dispatch.assignment a ON a.tenant_id=s.tenant_id AND a.id=s.assignment_id
      JOIN dispatch.run r ON r.tenant_id=a.tenant_id AND r.id=a.run_id
      WHERE s.tenant_id=$1 AND s.id=$2 AND r.service_date=$3::date AND s.lifecycle IN ('ACTIVE','SHIFT_ENDED') LIMIT 1`,
      [organizationId,shiftId,serviceDate])).rows[0];
    if(!shift)throw new RoadRoutingError(404,'RESOURCE_NOT_FOUND');
    const rows=(await db.query(`SELECT ST_Y(b.position::geometry) AS latitude,ST_X(b.position::geometry) AS longitude,b.accuracy_meters,b.captured_at
      FROM realtime.location_breadcrumb b JOIN realtime.location_batch_receipt receipt ON receipt.tenant_id=b.tenant_id AND receipt.id=b.batch_id
      WHERE b.tenant_id=$1 AND receipt.shift_id=$2 ORDER BY b.captured_at,b.id LIMIT $3`,
      [organizationId,shiftId,MAX_FIXES+1])).rows;
    const truncated=rows.length>MAX_FIXES;
    let points=rows.slice(0,MAX_FIXES).map(position);
    const legs=(await db.query(`SELECT rl.trip_leg_id,rl.ordinal FROM dispatch.run_leg rl
      WHERE rl.tenant_id=$1 AND rl.run_id=$2 AND ($3::uuid IS NULL OR EXISTS (
        SELECT 1 FROM intake.trip_leg leg JOIN intake.facility_trip_scope scope
          ON scope.tenant_id=leg.tenant_id AND scope.trip_id=leg.trip_request_id
        WHERE leg.tenant_id=rl.tenant_id AND leg.id=rl.trip_leg_id AND scope.facility_id=$3))
      ORDER BY rl.ordinal`,[organizationId,shift.run_id,clientId])).rows;
    if(clientId&&!legs.length)throw new RoadRoutingError(404,'RESOURCE_NOT_FOUND');
    if(legs.length){
      const actions=(await db.query(`SELECT resource_reference,command_reference,captured_at
        FROM execution.driver_action_receipt WHERE tenant_id=$1 AND shift_id=$2 AND resource_reference=ANY($3::uuid[]) AND outcome='APPLIED'
        ORDER BY captured_at`,[organizationId,shiftId,legs.map(row=>String(row.trip_leg_id))])).rows;
      const byLeg=new Map();
      for(const action of actions){const id=String(action.resource_reference);if(!byLeg.has(id))byLeg.set(id,[]);byLeg.get(id).push(action);}
      const intervals=legs.flatMap(leg=>{
        const events=byLeg.get(String(leg.trip_leg_id))??[];
        const start=events.find(action=>['MARK_EN_ROUTE','ARRIVE_PICKUP','BOARD_RIDER'].includes(action.command_reference));
        const end=events.find(action=>['COMPLETE_LEG','MARK_RIDER_NO_SHOW'].includes(action.command_reference));
        return start?[{from:new Date(start.captured_at).getTime(),to:new Date(end?.captured_at??points.at(-1)?.capturedAt??start.captured_at).getTime(),window:Number(leg.ordinal)}]:[];
      });
      intervals.sort((a,b)=>a.from-b.from);
      let windowIndex=0;
      points=points.flatMap(point=>{
        const instant=Date.parse(point.capturedAt);
        while(windowIndex<intervals.length&&instant>intervals[windowIndex].to)windowIndex++;
        const interval=intervals[windowIndex];
        if(interval&&instant>=interval.from&&instant<=interval.to)return [{...point,window:interval.window}];
        return clientId?[]:[point];
      });
    }
    return {shiftReference:shiftId,serviceDate,clientId,truncated,fixCount:points.length,points};
  });
}

export function splitTrace(points){
  const segments=[];
  for(const point of points){
    const previous=segments.at(-1)?.at(-1);
    if(!previous||point.window!==previous.window||Date.parse(point.capturedAt)-Date.parse(previous.capturedAt)>GAP_MS)segments.push([]);
    segments.at(-1).push(point);
  }
  return segments;
}

function meters(a,b){
  const rad=Math.PI/180;
  const lat=(a.latitude+b.latitude)*rad/2;
  return Math.hypot((a.latitude-b.latitude)*111195,(a.longitude-b.longitude)*111195*Math.cos(lat));
}

/** Keep turns and a 3-second heartbeat, while excluding thousands of stationary
 * duplicates that would consume matching credits without improving the path. */
export function matchingChunks(points){
  return splitTrace(points).flatMap(segment=>{
    if(segment.length<2)return [];
    const sampled=[segment[0]];
    for(let i=1;i<segment.length-1;i++){
      const point=segment[i],last=sampled.at(-1);
      if((Date.parse(point.capturedAt)-Date.parse(last.capturedAt)>=3000&&meters(point,last)>=5)||meters(point,last)>=20)sampled.push(point);
    }
    if(sampled.at(-1)!==segment.at(-1))sampled.push(segment.at(-1));
    const chunks=[];
    for(let start=0;start<sampled.length-1;start+=799)chunks.push(sampled.slice(start,Math.min(start+800,sampled.length)));
    return chunks.filter(chunk=>chunk.length>=2);
  });
}

function matchedLines(data){
  const coordinates=data?.features?.[0]?.geometry?.coordinates;
  if(!Array.isArray(coordinates))return null;
  const lines=coordinates.map(line=>Array.isArray(line)?line.map(coord=>[Number(coord?.[1]),Number(coord?.[0])]):[])
    .filter(line=>line.length>=2&&line.every(([lat,lon])=>Number.isFinite(lat)&&Math.abs(lat)<=85&&Number.isFinite(lon)&&Math.abs(lon)<=180));
  return lines.length?lines:null;
}

async function matchChunk(fetcher,apiKey,chunk){
  const url=new URL(MATCH_URL);url.searchParams.set('apiKey',apiKey);
  const body={mode:'drive',waypoints:chunk.map(point=>({location:[point.longitude,point.latitude],timestamp:point.capturedAt}))};
  const response=await fetcher(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(20000)});
  if(!response.ok)return null;
  return matchedLines(await response.json());
}

export function createDispatchTiledMapServices(pool,{apiKey=null,fetcher=fetch,usage=null}={}){
  const tileCache=new Map(),tileInFlight=new Map(),matchCache=new Map();
  let tileCacheBytes=0;
  const trace=input=>readDispatchTrace(pool,input);
  const tile=async({organizationId,z,x,y})=>{
    if(!validKey(apiKey))throw new RoadRoutingError(503,'MAPS_NOT_CONFIGURED');
    const name=`${z}/${x}/${y}`;
    const cached=tileCache.get(name);
    if(cached&&cached.expires>Date.now()){
      tileCache.delete(name);tileCache.set(name,cached);
      return {imageUrl:cached.imageUrl};
    }
    if(cached){tileCache.delete(name);tileCacheBytes-=cached.bytes;}
    if(tileInFlight.has(name))return tileInFlight.get(name);
    const work=(async()=>{
      const url=new URL(`${TILE_ROOT}/${z}/${x}/${y}.png`);url.searchParams.set('apiKey',apiKey);
      let response;
      try{response=await (usage?usage.record({tenantId:organizationId,provider:'GEOAPIFY',operation:'MAP_TILE',feature:'ROUTE_HISTORY'},()=>fetcher(url,{signal:AbortSignal.timeout(10000)}))
        :fetcher(url,{signal:AbortSignal.timeout(10000)}));}catch{throw new RoadRoutingError(503,'MAP_TILE_UNAVAILABLE');}
      if(!response.ok||!String(response.headers?.get('content-type')??'').startsWith('image/png'))throw new RoadRoutingError(503,'MAP_TILE_UNAVAILABLE');
      const bytes=Buffer.from(await response.arrayBuffer());
      if(!bytes.length||bytes.length>300000)throw new RoadRoutingError(503,'MAP_TILE_UNAVAILABLE');
      const imageUrl=`data:image/png;base64,${bytes.toString('base64')}`;
      const cacheSize=imageUrl.length;
      while(tileCache.size&&(tileCache.size>=256||tileCacheBytes+cacheSize>24*1024*1024)){
        const oldest=tileCache.keys().next().value;
        tileCacheBytes-=tileCache.get(oldest).bytes;tileCache.delete(oldest);
      }
      if(cacheSize<=24*1024*1024){tileCache.set(name,{imageUrl,bytes:cacheSize,expires:Date.now()+6*60*60_000});tileCacheBytes+=cacheSize;}
      return {imageUrl};
    })().finally(()=>tileInFlight.delete(name));
    tileInFlight.set(name,work);
    return work;
  };
  /** Bound both the browser request count and simultaneous provider calls. Failed
   * tiles do not discard the others in the same viewport. */
  const tileBatch=async({organizationId,tiles})=>{
    if(!Array.isArray(tiles)||!tiles.length||tiles.length>32)throw new RoadRoutingError(400,'INVALID_MAP_TILE_BATCH');
    const results=new Array(tiles.length);
    let next=0;
    await Promise.all(Array.from({length:Math.min(6,tiles.length)},async()=>{
      while(next<tiles.length){
        const index=next++,coords=tiles[index];
        try{results[index]={...coords,...await tile({...coords,organizationId})};}
        catch{results[index]={...coords,imageUrl:null};}
      }
    }));
    return {tiles:results};
  };
  const match=async input=>{
    if(!validKey(apiKey))return {status:'UNAVAILABLE',segments:[],windows:[]};
    const key=`${input.organizationId}|${input.serviceDate}|${input.shiftId}|${input.clientId??''}`;
    const cached=matchCache.get(key);
    if(cached&&cached.expires>Date.now())return {status:cached.status,segments:cached.segments,windows:cached.windows};
    const selected=await trace(input);
    if(selected.points.length<2)return {status:'READY',segments:[],windows:[]};
    {
      if(matchCache.size>=24)matchCache.delete(matchCache.keys().next().value);
      const entry={status:'PENDING',segments:[],windows:[],expires:Date.now()+30*60_000};
      matchCache.set(key,entry);
      const chunks=matchingChunks(selected.points);
      if(!chunks.length){entry.status='UNAVAILABLE';return {status:'UNAVAILABLE',segments:[],windows:[]};}
      void (async()=>{
        const results=new Array(chunks.length);
        let next=0;
        await Promise.all(Array.from({length:Math.min(2,chunks.length)},async()=>{
          while(next<chunks.length){
            const index=next++;
            try{results[index]=await matchChunk(usage?(url,options)=>usage.record({tenantId:input.organizationId,provider:'GEOAPIFY',operation:'MAP_MATCH',feature:'ROUTE_HISTORY'},()=>fetcher(url,options)):fetcher,apiKey,chunks[index]);}catch{results[index]=null;}
          }
        }));
        entry.segments=results.flatMap(lines=>lines??[]);
        entry.windows=results.flatMap((lines,index)=>Array.from({length:lines?.length??0},()=>chunks[index][0].window));
        entry.status=results.every(Boolean)?'READY':entry.segments.length?'PARTIAL':'UNAVAILABLE';
      })();
    }
    return {status:'PENDING',segments:[],windows:[]};
  };
  return {trace,tile,tileBatch,match};
}
