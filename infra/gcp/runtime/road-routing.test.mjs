import assert from 'node:assert/strict';
import test from 'node:test';
import {createGoogleRoadRoutingService,roadRoutingInternals} from './road-routing.mjs';

const encoded='_p~iF~ps|U_ulLnnqC_mqNvxq`@';
const sample=(distance,duration,maneuvers,toll=false)=>({
  distanceMeters:distance,duration:`${duration}s`,polyline:{encodedPolyline:encoded},
  legs:[{steps:maneuvers.map(maneuver=>({distanceMeters:500,navigationInstruction:{maneuver,instructions:`Follow ${maneuver}`}}))}],
  ...(toll?{travelAdvisory:{tollInfo:{estimatedPrice:[{currencyCode:'USD',units:'4',nanos:500000000}]}}}:{}),
});

test('three route goals use separate measurable preferences and permit the same roads',()=>{
  const routes=[sample(12000,600,['TURN_LEFT','MERGE'],true),sample(9000,850,['TURN_RIGHT','TURN_LEFT']),sample(11000,750,['STRAIGHT'])];
  assert.equal(roadRoutingInternals.choose(routes,'FASTEST').durationSeconds,600);
  assert.equal(roadRoutingInternals.choose(routes,'LOW_COST').distanceMeters,9000);
  assert.equal(roadRoutingInternals.choose(routes,'EASIEST').maneuverCount,0);
  assert.equal(roadRoutingInternals.choose([routes[2]],'LOW_COST').encoded,roadRoutingInternals.choose([routes[2]],'FASTEST').encoded);
});

test('provider requests apply route goals and links nudge Google Maps through the chosen road',()=>{
  const now=new Date(Date.now()+3_600_000).toISOString();
  const cost=roadRoutingInternals.providerRequest('1 Main St','2 Main St','LOW_COST',now);
  const easy=roadRoutingInternals.providerRequest('1 Main St','2 Main St','EASIEST',now);
  assert.equal(cost.computeAlternativeRoutes,true);
  assert.equal(cost.routeModifiers.avoidTolls,true);
  assert.equal(easy.routeModifiers.avoidFerries,true);
  assert.ok(cost.departureTime);
  const points=roadRoutingInternals.decodePolyline(encoded);
  const link=new URL(roadRoutingInternals.mapsUrl(points,'LOW_COST','1 Main St','2 Main St'));
  assert.equal(link.hostname,'www.google.com');
  assert.equal(link.searchParams.get('origin'),'1 Main St');
  assert.equal(link.searchParams.get('destination'),'2 Main St');
  assert.ok(link.searchParams.get('waypoints'));
  assert.equal(link.searchParams.get('avoid'),'tolls');
  assert.equal(link.searchParams.get('travelmode'),'driving');
});

test('routing stays inactive until separate server and browser map keys are configured',async()=>{
  const service=createGoogleRoadRoutingService({connect(){throw new Error('database should not be used');}},{apiKey:'AIza'+'a'.repeat(35)});
  assert.equal(service.configured,false);
  await assert.rejects(()=>service.preview({organizationId:'a',legId:'b',goal:'FASTEST',includeMap:true}),error=>error.code==='MAPS_NOT_CONFIGURED');
});

test('a mocked Google response produces a direct map URL, while PostgreSQL stores only the selected goal',async()=>{
  const calls=[];let selected=null;
  const client={release(){},async query(sql,params){
    if(sql.includes('FROM intake.trip_leg l'))return {rows:[{id:'11111111-1111-4111-8111-111111111111',origin:'1 Main St',destination:'2 Main St',planned_start_at:new Date(Date.now()+3600000)}]};
    if(sql.includes('SELECT id FROM intake.trip_leg WHERE'))return {rows:[{id:'11111111-1111-4111-8111-111111111111'}]};
    if(sql.includes('SELECT goal,version,selected_at'))return {rows:selected?[selected]:[]};
    if(sql.includes('INSERT INTO dispatch.selected_road_route')){
      selected={goal:params[2],version:(selected?.version??0)+1,selected_at:new Date('2026-09-23T12:00:00Z'),command_key:params[4]};
      return {rows:[selected]};
    }
    return {rows:[]};
  }};
  const pool={connect:async()=>client};
  const fetcher=async(url,options)=>{calls.push({url,options});
    if(url.startsWith('https://routes.googleapis.com/'))return {ok:true,json:async()=>({routes:[sample(12000,700,['TURN_LEFT'],true),sample(9000,850,['STRAIGHT'])]})};
    throw new Error('Static Maps must load directly in the browser');
  };
  const service=createGoogleRoadRoutingService(pool,{apiKey:'AIza'+'a'.repeat(35),staticMapKey:'AIza'+'b'.repeat(35),fetcher});
  const scope={organizationId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',legId:'11111111-1111-4111-8111-111111111111'};
  const preview=await service.preview({...scope,goal:'LOW_COST',includeMap:true});
  assert.equal(preview.distanceMeters,9000);
  assert.equal(new URL(preview.mapImageUrl).hostname,'maps.googleapis.com');
  assert.equal(new URL(preview.mapImageUrl).searchParams.get('key'),'AIza'+'b'.repeat(35));
  assert.equal(new URL(preview.googleMapsUrl).searchParams.get('origin'),'1 Main St');
  assert.equal(calls.length,1);
  assert.equal(calls[0].options.headers['X-Goog-Api-Key'],'AIza'+'a'.repeat(35));
  assert.ok(!JSON.stringify(preview).includes('AIza'+'a'.repeat(35)));
  assert.equal((await service.selection(scope)).goal,null);
  const first=await service.select({...scope,actorId:'22222222-2222-4222-8222-222222222222',goal:'LOW_COST',expectedVersion:0,key:'road-select-one'});
  assert.equal(first.version,1);
  const replay=await service.select({...scope,actorId:'22222222-2222-4222-8222-222222222222',goal:'LOW_COST',expectedVersion:0,key:'road-select-one'});
  assert.equal(replay.version,1);
  await assert.rejects(()=>service.select({...scope,actorId:'22222222-2222-4222-8222-222222222222',goal:'FASTEST',expectedVersion:0,key:'road-select-two'}),error=>error.statusCode===412);
  assert.equal((await service.selection(scope)).goal,'LOW_COST');
});
