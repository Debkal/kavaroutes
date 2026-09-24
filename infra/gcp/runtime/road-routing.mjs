import {createHash} from 'node:crypto';
import {withTenantTransaction} from '@kavaroutes/postgres-persistence';
import {RoadRoutingError} from '@kavaroutes/api-contracts';

const GEOCODE_URL='https://api.geoapify.com/v1/geocode/search';
const ROUTES_URL='https://api.geoapify.com/v1/routing';
const STATIC_MAP_URL='https://maps.geoapify.com/v1/staticmap';
const goals=new Set(['LOW_COST','FASTEST','EASIEST']);
const digest=value=>createHash('sha256').update(value).digest('hex');
const validNumber=value=>typeof value==='number'&&Number.isFinite(value);

function encodePolyline(points){
  let previousLat=0,previousLon=0,result='';
  for(const [lat,lon] of points){
    const latitude=Math.round(lat*1e5),longitude=Math.round(lon*1e5);
    for(let value of [latitude-previousLat,longitude-previousLon]){
      value=value<0?~(value<<1):value<<1;
      while(value>=32){result+=String.fromCharCode((32|(value&31))+63);value>>=5;}
      result+=String.fromCharCode(value+63);
    }
    previousLat=latitude;previousLon=longitude;
  }
  return result;
}
const coordinate=point=>`${point[0].toFixed(5)},${point[1].toFixed(5)}`;
function mapsUrl(points,goal,origin,destination){
  const url=new URL('https://www.google.com/maps/dir/');
  url.searchParams.set('api','1');
  url.searchParams.set('origin',origin||coordinate(points[0]));
  url.searchParams.set('destination',destination||coordinate(points.at(-1)));
  url.searchParams.set('travelmode','driving');
  if(points.length>2){
    const indices=[0.25,0.5,0.75].map(part=>Math.max(1,Math.min(points.length-2,Math.round((points.length-1)*part))));
    const via=[...new Set(indices)].map(index=>coordinate(points[index]));
    url.searchParams.set('waypoints',via.join('|'));
  }
  if(goal==='LOW_COST')url.searchParams.set('avoid','tolls');
  if(goal==='EASIEST')url.searchParams.set('avoid','ferries');
  if(url.href.length>2048){url.searchParams.set('origin',coordinate(points[0]));url.searchParams.set('destination',coordinate(points.at(-1)));}
  return url.href;
}
function steps(raw){
  const result=(raw.legs??[]).flatMap(leg=>leg.steps??[]).map(step=>({
    instruction:String(step.instruction?.text??'Continue').replace(/\s+/g,' ').trim().slice(0,500)||'Continue',
    maneuver:String(step.instruction?.type??'').slice(0,60),
    distanceMeters:Math.max(0,Math.round(Number(step.distance??0))),
  }));
  if(result.length>300||result.some(step=>!Number.isSafeInteger(step.distanceMeters)||step.distanceMeters<0))throw new RoadRoutingError(502,'MAPS_ROUTE_INVALID');
  return result;
}
function difficulty(items){
  return items.reduce((score,{maneuver})=>score+(maneuver.startsWith('TurnAround')||maneuver.startsWith('Ferry')?8
    :maneuver.startsWith('Sharp')?3: maneuver.startsWith('Merge')||maneuver.startsWith('Exit')?2
      :/Left|Right|Roundabout/.test(maneuver)?1:0),0);
}
function normalize(feature){
  const raw=feature?.properties;
  const lines=feature?.geometry?.type==='MultiLineString'?feature.geometry.coordinates:null;
  if(!raw||!Array.isArray(lines)||lines.length<1)throw new RoadRoutingError(502,'MAPS_ROUTE_INVALID');
  const coordinates=lines.flatMap((line,index)=>index?line.slice(1):line);
  if(coordinates.length<2||coordinates.length>20000||coordinates.some(point=>!Array.isArray(point)||point.length<2||!validNumber(point[0])||!validNumber(point[1])||Math.abs(point[0])>180||Math.abs(point[1])>90))throw new RoadRoutingError(502,'MAPS_ROUTE_INVALID');
  const points=coordinates.map(([lon,lat])=>[lat,lon]);
  const distanceMeters=Math.round(Number(raw.distance)),durationSeconds=Math.max(1,Math.round(Number(raw.time)));
  if(!Number.isSafeInteger(distanceMeters)||distanceMeters<1||!Number.isSafeInteger(durationSeconds))throw new RoadRoutingError(502,'MAPS_ROUTE_INVALID');
  const instructions=steps(raw),encoded=encodePolyline(points);
  if(encoded.length>50000)throw new RoadRoutingError(502,'MAPS_ROUTE_INVALID');
  return {durationSeconds,distanceMeters,encoded,points,steps:instructions,maneuverCount:difficulty(instructions),
    tollEstimate:null,tollsExpected:(raw.legs??[]).some(leg=>(leg.steps??[]).some(step=>step.toll===true))};
}
function providerRequest(origin,destination,goal,key){
  const url=new URL(ROUTES_URL);
  url.searchParams.set('apiKey',key);
  url.searchParams.set('waypoints',`${coordinate(origin)}|${coordinate(destination)}`);
  url.searchParams.set('mode','light_truck');
  url.searchParams.set('type',goal==='LOW_COST'?'short':goal==='EASIEST'?'less_maneuvers':'balanced');
  url.searchParams.set('traffic','approximated');
  url.searchParams.set('details','route_details,instruction_details');
  if(goal==='LOW_COST')url.searchParams.set('avoid','tolls');
  if(goal==='EASIEST')url.searchParams.set('avoid','ferries');
  return url;
}
async function providerJson(fetcher,url){
  let response;
  try{response=await fetcher(url,{signal:AbortSignal.timeout(12000)});}
  catch{throw new RoadRoutingError(502,'MAPS_ROUTE_UNAVAILABLE');}
  if(!response.ok)throw new RoadRoutingError(502,'MAPS_ROUTE_UNAVAILABLE');
  try{return await response.json();}catch{throw new RoadRoutingError(502,'MAPS_ROUTE_INVALID');}
}
async function geocode(fetcher,key,label){
  const url=new URL(GEOCODE_URL);url.searchParams.set('apiKey',key);url.searchParams.set('text',label);url.searchParams.set('format','json');url.searchParams.set('limit','1');
  const data=await providerJson(fetcher,url);
  const match=data.results?.[0];
  if(!validNumber(match?.lat)||!validNumber(match?.lon)||Math.abs(match.lat)>90||Math.abs(match.lon)>180||Number(match.rank?.confidence??0)<0.75)
    throw new RoadRoutingError(502,'MAPS_ADDRESS_UNRESOLVED');
  return [match.lat,match.lon];
}
async function geoapifyRoutes(fetcher,key,origin,destination,goal){
  const requested=goal==='FASTEST'?['FASTEST','LOW_COST','EASIEST']:[goal];
  const routes=await Promise.all(requested.map(async option=>{
    const data=await providerJson(fetcher,providerRequest(origin,destination,option,key));
    if(!Array.isArray(data.features)||!data.features.length)throw new RoadRoutingError(502,'MAPS_ROUTE_INVALID');
    return normalize(data.features[0]);
  }));
  return goal==='FASTEST'?routes.sort((a,b)=>a.durationSeconds-b.durationSeconds||a.distanceMeters-b.distanceMeters)[0]:routes[0];
}
async function staticMap(fetcher,key,route){
  const url=new URL(STATIC_MAP_URL);url.searchParams.set('apiKey',key);
  const markers=[route.points[0],route.points.at(-1)].map(([lat,lon],index)=>({lat,lon,type:'circle',color:index?'#bb694f':'#3d8a6e',size:30,text:index?'D':'P'}));
  const body={style:'positron',width:640,height:360,format:'png',attribution:'default',
    geometries:[{type:'polyline5',value:route.encoded,linecolor:'#2f6f8c',linewidth:5,lineopacity:0.95}],markers};
  let response;
  try{response=await fetcher(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(12000)});}
  catch{return null;}
  if(!response.ok||!String(response.headers?.get('content-type')??'').startsWith('image/png'))return null;
  try{const bytes=Buffer.from(await response.arrayBuffer());return bytes.length>0&&bytes.length<=450000?`data:image/png;base64,${bytes.toString('base64')}`:null;}
  catch{return null;}
}
async function leg(client,organizationId,legId,driverId){
  const result=await client.query(`SELECT l.id,origin.customer_label AS origin,destination.customer_label AS destination,
      ST_Y(origin.operational_point::geometry) AS origin_lat,ST_X(origin.operational_point::geometry) AS origin_lon,
      ST_Y(destination.operational_point::geometry) AS destination_lat,ST_X(destination.operational_point::geometry) AS destination_lon
    FROM intake.trip_leg l
    JOIN intake.trip_request trip ON trip.tenant_id=l.tenant_id AND trip.id=l.trip_request_id
    JOIN dispatch.run_leg rl ON rl.tenant_id=l.tenant_id AND rl.trip_leg_id=l.id
    JOIN dispatch.run run ON run.tenant_id=rl.tenant_id AND run.id=rl.run_id
    JOIN intake.address origin ON origin.tenant_id=l.tenant_id AND origin.id=l.origin_address_id
    JOIN intake.address destination ON destination.tenant_id=l.tenant_id AND destination.id=l.destination_address_id
    WHERE l.tenant_id=$1 AND l.id=$2 AND run.lifecycle_reference<>'cancelled' AND trip.lifecycle_reference<>'cancelled'
      AND ($3::uuid IS NULL OR EXISTS(SELECT 1 FROM dispatch.assignment a WHERE a.tenant_id=run.tenant_id AND a.run_id=run.id AND a.driver_id=$3
        AND NOT EXISTS(SELECT 1 FROM dispatch.assignment_supersession s WHERE s.tenant_id=a.tenant_id AND s.prior_assignment_id=a.id)))
    LIMIT 1`,[organizationId,legId,driverId??null]);
  if(!result.rows[0])throw new RoadRoutingError(404,'RESOURCE_NOT_FOUND');
  return result.rows[0];
}
const selectionFrom=row=>row?{goal:row.goal,version:Number(row.version),selectedAt:new Date(row.selected_at).toISOString()}
  :{goal:null,version:0,selectedAt:null};

export function createGeoapifyRoadRoutingService(pool,{apiKey=null,fetcher=fetch}={}){
  const configured=typeof apiKey==='string'&&/^[A-Za-z0-9_-]{20,200}$/.test(apiKey);
  const geocodeCache=new Map();
  const resolvePoint=(label,lat,lon)=>{
    if(validNumber(Number(lat))&&validNumber(Number(lon))&&lat!==null&&lon!==null)return Promise.resolve([Number(lat),Number(lon)]);
    if(!geocodeCache.has(label)){
      if(geocodeCache.size>=500)geocodeCache.delete(geocodeCache.keys().next().value);
      const pending=geocode(fetcher,apiKey,label).catch(error=>{geocodeCache.delete(label);throw error;});
      geocodeCache.set(label,pending);
    }
    return geocodeCache.get(label);
  };
  return Object.freeze({
    configured,
    async selection({organizationId,legId,driverId}){
      return withTenantTransaction(pool,organizationId,'kavaroutes_api',async client=>{
        await leg(client,organizationId,legId,driverId);
        const row=(await client.query('SELECT goal,version,selected_at FROM dispatch.selected_road_route WHERE tenant_id=$1 AND trip_leg_id=$2',[organizationId,legId])).rows[0];
        return selectionFrom(row);
      });
    },
    async preview({organizationId,legId,goal,includeMap,driverId}){
      if(!goals.has(goal))throw new RoadRoutingError(409,'ROUTE_GOAL_INVALID');
      if(!configured)throw new RoadRoutingError(503,'MAPS_NOT_CONFIGURED');
      const row=await withTenantTransaction(pool,organizationId,'kavaroutes_api',client=>leg(client,organizationId,legId,driverId));
      const [origin,destination]=await Promise.all([resolvePoint(row.origin,row.origin_lat,row.origin_lon),resolvePoint(row.destination,row.destination_lat,row.destination_lon)]);
      const route=await geoapifyRoutes(fetcher,apiKey,origin,destination,goal);
      const mapImageUrl=includeMap?await staticMap(fetcher,apiKey,route):null;
      const note=goal==='LOW_COST'?'Prefers toll-free roads and a shorter distance. Actual toll, fuel, and labor costs are not quoted.':goal==='FASTEST'
        ?'Shortest estimated time among the proposed routes. Traffic is approximate, not live.':'Prefers fewer maneuvers and avoids ferries when practical.';
      return {goal,provider:'GEOAPIFY',distanceMeters:route.distanceMeters,durationSeconds:route.durationSeconds,
        tollEstimate:route.tollEstimate,tollsExpected:route.tollsExpected,maneuverCount:route.maneuverCount,
        pathFingerprint:digest(route.encoded),steps:route.steps,mapImageUrl,googleMapsUrl:mapsUrl(route.points,goal,row.origin,row.destination),note};
    },
    async select({organizationId,legId,actorId,goal,expectedVersion,key}){
      if(!configured)throw new RoadRoutingError(503,'MAPS_NOT_CONFIGURED');
      if(!goals.has(goal)||!Number.isSafeInteger(expectedVersion)||expectedVersion<0||typeof key!=='string'||key.length>200)throw new RoadRoutingError(409,'ROUTE_SELECTION_INVALID');
      return withTenantTransaction(pool,organizationId,'kavaroutes_api',async client=>{
        const locked=await client.query('SELECT id FROM intake.trip_leg WHERE tenant_id=$1 AND id=$2 FOR UPDATE',[organizationId,legId]);
        if(!locked.rows[0])throw new RoadRoutingError(404,'RESOURCE_NOT_FOUND');
        await leg(client,organizationId,legId);
        const current=(await client.query('SELECT goal,version,selected_at,command_key FROM dispatch.selected_road_route WHERE tenant_id=$1 AND trip_leg_id=$2',[organizationId,legId])).rows[0];
        if(current?.command_key===key){if(current.goal!==goal)throw new RoadRoutingError(409,'ROUTE_SELECTION_CONFLICT');return selectionFrom(current);}
        if(Number(current?.version??0)!==expectedVersion)throw new RoadRoutingError(412,'ROUTE_SELECTION_STALE');
        const result=await client.query(`INSERT INTO dispatch.selected_road_route(tenant_id,trip_leg_id,goal,version,selected_by,command_key)
          VALUES($1,$2,$3,1,$4,$5) ON CONFLICT(tenant_id,trip_leg_id) DO UPDATE SET goal=EXCLUDED.goal,
          version=dispatch.selected_road_route.version+1,selected_by=EXCLUDED.selected_by,selected_at=now(),command_key=EXCLUDED.command_key
          RETURNING goal,version,selected_at`,[organizationId,legId,goal,actorId,key]);
        return selectionFrom(result.rows[0]);
      });
    },
  });
}

export const roadRoutingInternals={encodePolyline,normalize,providerRequest,mapsUrl};
