import assert from 'node:assert/strict';
import test from 'node:test';
import {createGeoapifyRoadRoutingService,roadRoutingInternals} from './road-routing.mjs';

const key='test-geoapify-secret-'+'x'.repeat(20);
const geometry=[[-118.243683,34.052235],[-118.239,34.057],[-118.233683,34.062235]];
const sample=(distance,time,maneuvers,toll=false)=>({type:'Feature',geometry:{type:'MultiLineString',coordinates:[geometry]},
  properties:{distance,time,legs:[{steps:maneuvers.map(type=>({distance:500,toll,instruction:{type,text:'Follow '+type}}))}]}});

test('Geoapify goals request short/toll-avoid, balanced and fewer-maneuver routes',()=>{
  const point=[34.052235,-118.243683];
  const cost=roadRoutingInternals.providerRequest(point,point,'LOW_COST',key);
  const fast=roadRoutingInternals.providerRequest(point,point,'FASTEST',key);
  const easy=roadRoutingInternals.providerRequest(point,point,'EASIEST',key);
  assert.equal(cost.searchParams.get('type'),'short');
  assert.equal(cost.searchParams.get('avoid'),'tolls');
  assert.equal(fast.searchParams.get('type'),'balanced');
  assert.equal(easy.searchParams.get('type'),'less_maneuvers');
  assert.equal(easy.searchParams.get('avoid'),'ferries');
  assert.equal(fast.searchParams.get('mode'),'light_truck');
  assert.equal(fast.searchParams.get('traffic'),'approximated');
  const encoded=roadRoutingInternals.encodePolyline(geometry.map(([lon,lat])=>[lat,lon]));
  assert.ok(encoded.length>0);
  const link=new URL(roadRoutingInternals.mapsUrl(geometry.map(([lon,lat])=>[lat,lon]),'LOW_COST','1 Main St','2 Main St'));
  assert.equal(link.hostname,'www.google.com');
  assert.equal(link.searchParams.get('avoid'),'tolls');
});

test('routing is unavailable until a server secret is configured',async()=>{
  const service=createGeoapifyRoadRoutingService({connect(){throw new Error('database should not be used');}});
  assert.equal(service.configured,false);
  await assert.rejects(()=>service.preview({organizationId:'a',legId:'b',goal:'FASTEST',includeMap:true}),error=>error.code==='MAPS_NOT_CONFIGURED');
});

test('route, geocode and static map stay server side while selected goal persists',async()=>{
  const calls=[];let selected=null;
  const client={release(){},async query(sql,params){
    if(sql.includes('FROM intake.trip_leg l'))return {rows:[{id:'11111111-1111-4111-8111-111111111111',origin:'1 Main St',destination:'2 Main St',origin_lat:null,origin_lon:null,destination_lat:null,destination_lon:null}]};
    if(sql.includes('SELECT id FROM intake.trip_leg WHERE'))return {rows:[{id:'11111111-1111-4111-8111-111111111111'}]};
    if(sql.includes('SELECT goal,version,selected_at'))return {rows:selected?[selected]:[]};
    if(sql.includes('INSERT INTO dispatch.selected_road_route')){
      selected={goal:params[2],version:(selected?.version??0)+1,selected_at:new Date('2026-09-23T12:00:00Z'),command_key:params[4]};return {rows:[selected]};
    }
    return {rows:[]};
  }};
  const fetcher=async(url,options)=>{const parsed=new URL(url);calls.push({host:parsed.hostname,path:parsed.pathname,options});
    if(parsed.pathname==='/v1/geocode/search')return {ok:true,json:async()=>({results:[{lat:34.052235,lon:-118.243683,rank:{confidence:0.99}}]})};
    if(parsed.pathname==='/v1/routing')return {ok:true,json:async()=>({features:[sample(9000,850,['Left','Right'])]})};
    if(parsed.pathname==='/v1/staticmap')return {ok:true,headers:{get:()=> 'image/png'},arrayBuffer:async()=>Buffer.from('png-data')};
    throw new Error('unexpected URL');
  };
  const service=createGeoapifyRoadRoutingService({connect:async()=>client},{apiKey:key,fetcher});
  const scope={organizationId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',legId:'11111111-1111-4111-8111-111111111111'};
  const preview=await service.preview({...scope,goal:'LOW_COST',includeMap:true});
  assert.equal(preview.provider,'GEOAPIFY');
  assert.equal(preview.distanceMeters,9000);
  assert.equal(preview.mapImageUrl,'data:image/png;base64,'+Buffer.from('png-data').toString('base64'));
  assert.ok(!JSON.stringify(preview).includes(key));
  assert.equal(calls.filter(call=>call.path==='/v1/geocode/search').length,2);
  assert.equal(calls.filter(call=>call.path==='/v1/routing').length,1);
  assert.equal(calls.filter(call=>call.path==='/v1/staticmap').length,1);
  assert.equal((await service.selection(scope)).goal,null);
  const first=await service.select({...scope,actorId:'22222222-2222-4222-8222-222222222222',goal:'LOW_COST',expectedVersion:0,key:'road-select-one'});
  assert.equal(first.version,1);
  assert.equal((await service.selection(scope)).goal,'LOW_COST');
});

test('fastest picks the shortest estimated duration from the three candidates',async()=>{
  const client={release(){},async query(sql){return {rows:sql.includes('FROM intake.trip_leg l')?[{origin:'1 Main St',destination:'2 Main St',origin_lat:34,origin_lon:-118,destination_lat:34.1,destination_lon:-118.1}]:[]};}};
  const fetcher=async(url)=>{const type=new URL(url).searchParams.get('type');return {ok:true,json:async()=>({features:[sample(9000,type==='short'?500:type==='less_maneuvers'?850:700,['Right'])]})};};
  const service=createGeoapifyRoadRoutingService({connect:async()=>client},{apiKey:key,fetcher});
  const result=await service.preview({organizationId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',legId:'11111111-1111-4111-8111-111111111111',goal:'FASTEST',includeMap:false});
  assert.equal(result.durationSeconds,500);
  assert.equal(result.mapImageUrl,null);
});
