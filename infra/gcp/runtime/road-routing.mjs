import {createHash} from 'node:crypto';
import {withTenantTransaction} from '@kavaroutes/postgres-persistence';
import {RoadRoutingError} from '@kavaroutes/api-contracts';

const ROUTES_URL='https://routes.googleapis.com/directions/v2:computeRoutes';
const STATIC_MAP_URL='https://maps.googleapis.com/maps/api/staticmap';
const FIELD_MASK='routes.duration,routes.distanceMeters,routes.polyline.encodedPolyline,routes.legs.steps.navigationInstruction,routes.legs.steps.distanceMeters,routes.travelAdvisory.tollInfo';
const goals=new Set(['LOW_COST','FASTEST','EASIEST']);
const digest=value=>createHash('sha256').update(value).digest('hex');
const seconds=value=>{const match=/^(\d+(?:\.\d+)?)s$/.exec(String(value??''));return match?Math.max(1,Math.round(Number(match[1]))):null;};
const validNumber=value=>typeof value==='number'&&Number.isFinite(value);

function decodePolyline(encoded){
  const points=[];let latitude=0,longitude=0,index=0;
  while(index<encoded.length&&points.length<20000){
    const values=[];
    for(let coordinate=0;coordinate<2;coordinate++){
      let result=0,shift=0,byte;
      do{if(index>=encoded.length||shift>30)throw new RoadRoutingError(502,'MAPS_ROUTE_INVALID');byte=encoded.charCodeAt(index++)-63;result|=(byte&31)<<shift;shift+=5;}while(byte>=32);
      values.push(result&1?~(result>>1):result>>1);
    }
    latitude+=values[0];longitude+=values[1];points.push([latitude/1e5,longitude/1e5]);
  }
  if(points.length<2||index!==encoded.length||points.some(([lat,lng])=>Math.abs(lat)>90||Math.abs(lng)>180))throw new RoadRoutingError(502,'MAPS_ROUTE_INVALID');
  return points;
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
function toll(raw){
  const prices=raw?.travelAdvisory?.tollInfo?.estimatedPrice;
  const price=Array.isArray(prices)?prices[0]:null;
  if(!price||!/^[A-Z]{3}$/.test(String(price.currencyCode??'')))return null;
  const amount=Number(price.units??0)+Number(price.nanos??0)/1e9;
  return Number.isFinite(amount)&&amount>=0?{currencyCode:price.currencyCode,amount:Math.round(amount*100)/100}:null;
}
function steps(raw){
  const result=(raw.legs??[]).flatMap(leg=>leg.steps??[]).map(step=>({
    instruction:String(step.navigationInstruction?.instructions??'Continue').replace(/\s+/g,' ').trim().slice(0,500)||'Continue',
    maneuver:String(step.navigationInstruction?.maneuver??'').slice(0,60),
    distanceMeters:Number(step.distanceMeters??0),
  }));
  if(result.length>300||result.some(step=>!Number.isSafeInteger(step.distanceMeters)||step.distanceMeters<0))throw new RoadRoutingError(502,'MAPS_ROUTE_INVALID');
  return result;
}
function difficulty(items){
  return items.reduce((score,step)=>{
    const maneuver=step.maneuver;
    if(maneuver.startsWith('UTURN'))return score+8;
    if(maneuver.startsWith('FERRY'))return score+8;
    if(maneuver.startsWith('TURN_SHARP'))return score+3;
    if(maneuver==='MERGE'||maneuver.startsWith('RAMP'))return score+2;
    if(maneuver.startsWith('TURN')||maneuver.startsWith('FORK')||maneuver.startsWith('ROUNDABOUT'))return score+1;
    return score;
  },0);
}
function normalize(raw){
  const durationSeconds=seconds(raw.duration),distanceMeters=Number(raw.distanceMeters),encoded=raw.polyline?.encodedPolyline;
  if(!durationSeconds||!Number.isSafeInteger(distanceMeters)||distanceMeters<1||typeof encoded!=='string'||!encoded.length||encoded.length>20000)throw new RoadRoutingError(502,'MAPS_ROUTE_INVALID');
  const instructions=steps(raw),points=decodePolyline(encoded);
  return {durationSeconds,distanceMeters,encoded,points,steps:instructions,maneuverCount:difficulty(instructions),tollEstimate:toll(raw),tollsExpected:!!raw.travelAdvisory?.tollInfo};
}
function choose(routes,goal){
  const list=routes.map(normalize);
  if(!list.length)throw new RoadRoutingError(502,'MAPS_ROUTE_UNAVAILABLE');
  const fastest=Math.min(...list.map(route=>route.durationSeconds));
  const eligible=goal==='EASIEST'?list.filter(route=>route.durationSeconds<=fastest*1.5+300):list;
  const options=eligible.length?eligible:list;
  options.sort((a,b)=>goal==='FASTEST'
    ?a.durationSeconds-b.durationSeconds||a.distanceMeters-b.distanceMeters
    :goal==='LOW_COST'
      ?Number(a.tollsExpected)-Number(b.tollsExpected)||a.distanceMeters-b.distanceMeters||a.durationSeconds-b.durationSeconds
      :a.maneuverCount-b.maneuverCount||a.durationSeconds-b.durationSeconds||a.distanceMeters-b.distanceMeters);
  return options[0];
}
function providerRequest(origin,destination,goal,plannedStartAt){
  const routeModifiers=goal==='LOW_COST'?{avoidTolls:true}:goal==='EASIEST'?{avoidFerries:true}:{};
  const departure=new Date(plannedStartAt).getTime();
  return {origin:{address:origin},destination:{address:destination},travelMode:'DRIVE',
    routingPreference:'TRAFFIC_AWARE_OPTIMAL',computeAlternativeRoutes:true,polylineQuality:'OVERVIEW',
    routeModifiers,extraComputations:['TOLLS'],languageCode:'en-US',units:'IMPERIAL',
    ...(Number.isFinite(departure)&&departure>Date.now()+60_000?{departureTime:new Date(departure).toISOString()}:{})};
}
async function googleRoutes(fetcher,key,origin,destination,goal,plannedStartAt){
  let response;
  try{response=await fetcher(ROUTES_URL,{method:'POST',headers:{'content-type':'application/json','X-Goog-Api-Key':key,'X-Goog-FieldMask':FIELD_MASK},
    body:JSON.stringify(providerRequest(origin,destination,goal,plannedStartAt)),signal:AbortSignal.timeout(12000)});}
  catch{throw new RoadRoutingError(502,'MAPS_ROUTE_UNAVAILABLE');}
  if(!response.ok)throw new RoadRoutingError(502,'MAPS_ROUTE_UNAVAILABLE');
  let data;try{data=await response.json();}catch{throw new RoadRoutingError(502,'MAPS_ROUTE_INVALID');}
  if(!Array.isArray(data.routes))throw new RoadRoutingError(502,'MAPS_ROUTE_INVALID');
  return choose(data.routes,goal);
}
async function staticMap(fetcher,key,route){
  const url=new URL(STATIC_MAP_URL);
  url.searchParams.set('size','640x360');url.searchParams.set('scale','1');url.searchParams.set('format','png');
  url.searchParams.append('path',`color:0x2f6f8cff|weight:5|enc:${route.encoded}`);
  url.searchParams.append('markers',`color:green|label:P|${coordinate(route.points[0])}`);
  url.searchParams.append('markers',`color:red|label:D|${coordinate(route.points.at(-1))}`);
  url.searchParams.set('key',key);
  if(url.href.length>16000)throw new RoadRoutingError(502,'MAPS_MAP_UNAVAILABLE');
  let response;try{response=await fetcher(url.href,{signal:AbortSignal.timeout(12000)});}catch{throw new RoadRoutingError(502,'MAPS_MAP_UNAVAILABLE');}
  if(!response.ok||!String(response.headers.get('content-type')??'').startsWith('image/png'))throw new RoadRoutingError(502,'MAPS_MAP_UNAVAILABLE');
  const bytes=Buffer.from(await response.arrayBuffer());
  if(!bytes.length||bytes.length>500000)throw new RoadRoutingError(502,'MAPS_MAP_UNAVAILABLE');
  return `data:image/png;base64,${bytes.toString('base64')}`;
}
async function leg(client,organizationId,legId,driverId){
  const result=await client.query(`SELECT l.id,origin.customer_label AS origin,destination.customer_label AS destination,l.planned_start_at
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

export function createGoogleRoadRoutingService(pool,{apiKey=null,fetcher=fetch}={}){
  const configured=typeof apiKey==='string'&&apiKey.length>0;
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
      const route=await googleRoutes(fetcher,apiKey,row.origin,row.destination,goal,row.planned_start_at);
      const mapImageDataUrl=includeMap?await staticMap(fetcher,apiKey,route):null;
      const note=goal==='LOW_COST'?'Prefers toll-free roads, then the shortest distance. Fuel and labor costs are not quoted.':goal==='FASTEST'
        ?'Prefers the shortest traffic-aware travel time.':'Prefers fewer complex turns and avoids ferries when practical.';
      return {goal,provider:'GOOGLE_ROUTES',distanceMeters:route.distanceMeters,durationSeconds:route.durationSeconds,
        tollEstimate:route.tollEstimate,tollsExpected:route.tollsExpected,maneuverCount:route.maneuverCount,
        pathFingerprint:digest(route.encoded),steps:route.steps,mapImageDataUrl,googleMapsUrl:mapsUrl(route.points,goal,row.origin,row.destination),note};
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

export const roadRoutingInternals={decodePolyline,choose,providerRequest,mapsUrl};
