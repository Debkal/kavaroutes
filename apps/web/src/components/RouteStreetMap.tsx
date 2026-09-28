import {useEffect,useMemo,useRef,useState,type ReactNode} from 'react';
import {useQuery} from '@tanstack/react-query';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import type {createCloudApi} from '../cloud-api';
import {googleMapsRouteUrl} from '../route-trace-export';
import {distanceByWindow,miles} from '../route-distance';

type Api=ReturnType<typeof createCloudApi>;
type Track=Awaited<ReturnType<Api['tracking']>>['value']['shifts'][number];
type Point=Track['trace'][number]&{window?:number};
export const legColor=(window:number)=>window===0?'#65758a':['#17637c','#a13f67','#8c631b','#614ba5','#2e7658'][(window-1)%5]!;
const TILE_CACHE=new Map<string,string>();
let tileCacheBytes=0;
function rememberTile(key:string,imageUrl:string){
  const prior=TILE_CACHE.get(key);
  if(prior){tileCacheBytes-=prior.length;TILE_CACHE.delete(key);}
  while(TILE_CACHE.size&&(TILE_CACHE.size>=256||tileCacheBytes+imageUrl.length>16*1024*1024)){
    const oldest=TILE_CACHE.keys().next().value!;
    tileCacheBytes-=TILE_CACHE.get(oldest)!.length;TILE_CACHE.delete(oldest);
  }
  if(imageUrl.length<=16*1024*1024){TILE_CACHE.set(key,imageUrl);tileCacheBytes+=imageUrl.length;}
}

function split(points:readonly Point[]):{window:number;coords:[number,number][]}[]{
  const segments:{window:number;coords:[number,number][]}[]=[];
  for(let i=0;i<points.length;i++){
    const point=points[i]!,previous=points[i-1];
    if(!previous||point.window!==previous.window||Date.parse(point.capturedAt)-Date.parse(previous.capturedAt)>90_000)segments.push({window:point.window??0,coords:[]});
    segments[segments.length-1]!.coords.push([point.latitude,point.longitude]);
  }
  return segments;
}

/** The tiles stay in the browser cache during pan/zoom. Every tile is requested
 * through the authorized API, so its provider key never reaches a browser URL. */
export function RouteStreetMap({api,day,track,clientId=null,history=false,selectedWindow=null,legLabels=[],fallback}:{
  api:Api;day:string;track:Track;clientId?:string|null;history?:boolean;selectedWindow?:number|null;
  legLabels?:readonly {window:number;label:string}[];fallback:ReactNode;
}){
  const container=useRef<HTMLDivElement>(null),map=useRef<any>(null),overlay=useRef<any>(null);
  const [raw,setRaw]=useState(false),[tileError,setTileError]=useState(false);
  const full=useQuery({queryKey:['private-cloud','dispatch-full-trace',day,track.shiftReference,clientId],
    queryFn:()=>api.fullTrace(day,track.shiftReference,clientId),staleTime:60_000,retry:false});
  const saved=full.data?.value.points;
  const points=useMemo(()=>{
    if(!saved)return [];
    if(history||clientId||!saved.length)return saved;
    const last=Date.parse(saved.at(-1)!.capturedAt);
    const fresh=track.trace.filter(point=>Date.parse(point.capturedAt)>last).map(point=>({...point,window:0}));
    return fresh.length?[...saved,...fresh]:saved;
  },[saved,track.trace,history,clientId]);
  const match=useQuery({queryKey:['private-cloud','dispatch-trace-match',day,track.shiftReference,clientId],
    queryFn:()=>api.traceMatch(day,track.shiftReference,clientId),enabled:history&&points.length>1,
    refetchInterval:query=>query.state.data?.value.status==='PENDING'?5000:false,staleTime:5*60_000,retry:false});
  const visiblePoints=useMemo(()=>selectedWindow===null?points:points.filter(point=>point.window===selectedWindow),[points,selectedWindow]);
  const allSegments=useMemo(()=>split(points),[points]);
  const segments=useMemo(()=>split(visiblePoints),[visiblePoints]);
  const matched=match.data?.value.status==='READY'||match.data?.value.status==='PARTIAL';
  const distances=useMemo(()=>distanceByWindow(match.data?.value.status==='READY'?
    match.data.value.segments.map((coords,index)=>({coords,window:match.data!.value.windows[index]??0})):allSegments),[match.data,allSegments]);
  const distanceMethod=match.data?.value.status==='READY'?'road-aligned':'GPS estimate';
  const googleUrl=googleMapsRouteUrl(visiblePoints);

  useEffect(()=>{
    if(!container.current||!points.length||map.current)return;
    const instance=L.map(container.current,{minZoom:4,maxZoom:19,zoomControl:true,preferCanvas:true});
    map.current=instance;
    const waiting=new Map<string,{coords:{z:number;x:number;y:number};listeners:{img:HTMLImageElement;done:(error:Error|null,tile:HTMLImageElement)=>void}[]}>();
    let timer:number|undefined;
    const deliver=(key:string,imageUrl:string|null,listeners:{img:HTMLImageElement;done:(error:Error|null,tile:HTMLImageElement)=>void}[])=>{
      if(imageUrl){
        rememberTile(key,imageUrl);
      }
      for(const {img,done} of listeners){
        if(imageUrl)img.src=imageUrl;
        else{setTileError(true);done(new Error('MAP_TILE_UNAVAILABLE'),img);}
      }
    };
    const flush=()=>{
      timer=undefined;
      const batch=[...waiting.entries()].slice(0,32);
      for(const [key] of batch)waiting.delete(key);
      if(waiting.size)timer=window.setTimeout(flush,16);
      if(!batch.length)return;
      void api.mapTiles(batch.map(([,item])=>item.coords)).then(result=>{
        batch.forEach(([key,item],index)=>deliver(key,result.value.tiles[index]?.imageUrl??null,item.listeners));
      }).catch(()=>batch.forEach(([key,item])=>deliver(key,null,item.listeners)));
    };
    const AuthorizedTiles=L.TileLayer.extend({createTile(coords:{z:number;x:number;y:number},done:(error:Error|null,tile:HTMLImageElement)=>void){
      const img=document.createElement('img');img.alt='';img.width=256;img.height=256;
      const key=`${coords.z}/${coords.x}/${coords.y}`;
      img.onload=()=>done(null,img);img.onerror=()=>{setTileError(true);done(new Error('MAP_TILE_UNAVAILABLE'),img);};
      const cached=TILE_CACHE.get(key);
      if(cached){rememberTile(key,cached);img.src=cached;return img;}
      const queued=waiting.get(key);
      if(queued)queued.listeners.push({img,done});
      else waiting.set(key,{coords,listeners:[{img,done}]});
      if(timer===undefined)timer=window.setTimeout(flush,16);
      return img;
    }});
    new AuthorizedTiles('',{tileSize:256,maxZoom:19,attribution:'© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a> · <a href="https://www.geoapify.com/">Geoapify</a>'}).addTo(instance);
    return()=>{if(timer!==undefined)window.clearTimeout(timer);waiting.clear();instance.remove();map.current=null;overlay.current=null;};
  },[api,points.length>0,day,track.shiftReference,clientId]);

  useEffect(()=>{
    const instance=map.current;if(!instance)return;
    if(overlay.current)instance.removeLayer(overlay.current);
    if(!visiblePoints.length){overlay.current=null;return;}
    const group=L.layerGroup();overlay.current=group;
    if(match.data?.value.status==='PARTIAL'&&!raw)for(const line of segments)if(line.coords.length>1)L.polyline(line.coords,{color:legColor(line.window),weight:3,opacity:.4,smoothFactor:0}).addTo(group);
    const lines=matched&&!raw?match.data!.value.segments.map((coords,index)=>({coords,window:match.data!.value.windows[index]??0}))
      .filter(line=>selectedWindow===null||line.window===selectedWindow):segments;
    for(const line of lines)if(line.coords.length>1)L.polyline(line.coords,{color:legColor(line.window),weight:5,opacity:.92,smoothFactor:0}).addTo(group);
    const first=visiblePoints[0]!,last=visiblePoints.at(-1)!;
    L.circleMarker([first.latitude,first.longitude],{radius:8,color:'#fff',weight:2,fillColor:'#2e7658',fillOpacity:1}).bindTooltip('First saved fix').addTo(group);
    L.circleMarker([last.latitude,last.longitude],{radius:8,color:'#fff',weight:2,fillColor:'#af6546',fillOpacity:1}).bindTooltip('Last saved fix').addTo(group);
    group.addTo(instance);
  },[visiblePoints,segments,match.data,matched,raw,selectedWindow]);

  useEffect(()=>{
    const instance=map.current;if(!instance||!visiblePoints.length)return;
    const bounds=L.latLngBounds([visiblePoints[0]!.latitude,visiblePoints[0]!.longitude],[visiblePoints[0]!.latitude,visiblePoints[0]!.longitude]);
    for(const point of visiblePoints)bounds.extend([point.latitude,point.longitude]);
    instance.fitBounds(bounds.pad(.12),{maxZoom:17});
    window.setTimeout(()=>instance.invalidateSize(),0);
  },[day,track.shiftReference,clientId,selectedWindow,points.length>0]);

  const fit=()=>{
    const instance=map.current;if(!instance||!visiblePoints.length)return;
    const bounds=L.latLngBounds([visiblePoints[0]!.latitude,visiblePoints[0]!.longitude],[visiblePoints[0]!.latitude,visiblePoints[0]!.longitude]);
    for(const point of visiblePoints)bounds.extend([point.latitude,point.longitude]);
    instance.fitBounds(bounds.pad(.12),{maxZoom:17});
  };
  if(full.isPending)return <p role="status">Loading all saved GPS fixes for this shift…</p>;
  if(full.isError)return <><p role="alert">The full GPS trace could not load. The recent-fix plot is shown below.</p>{fallback}</>;
  if(!points.length)return <>{fallback}</>;
  const gaps=visiblePoints.reduce((count,point,index)=>count+(index>0&&Date.parse(point.capturedAt)-Date.parse(visiblePoints[index-1]!.capturedAt)>90_000?1:0),0);
  return <div className="route-map-wrap">
    <div className="route-map-controls" role="group" aria-label="Street map controls">
      <button type="button" onClick={fit} disabled={!visiblePoints.length}>Fit route</button>
      {matched&&<button type="button" aria-pressed={raw} onClick={()=>setRaw(value=>!value)}>{raw?'Show road-aligned path':'Show raw GPS'}</button>}
      {googleUrl&&<a href={googleUrl} target="_blank" rel="noopener noreferrer">Open approximate directions in Google Maps</a>}
    </div>
    <figure className="route-street-map">
      <div ref={container} className="route-street-viewport" role="region" aria-label="Interactive street map with pan, pinch and scroll zoom" tabIndex={0}/>
      {history&&legLabels.length>0&&<div className="route-map-legend" aria-label="Route key and distances">
        <strong>Route key</strong><small>Distance: {distanceMethod}</small>
        {legLabels.map(leg=><div key={leg.window} className={selectedWindow!==null&&selectedWindow!==leg.window?'muted':''}>
          <span className="route-map-legend-line" style={{backgroundColor:legColor(leg.window)}} aria-hidden="true"/>
          <span>{leg.label}</span><b>{distances.has(leg.window)?miles(distances.get(leg.window)!):'No fixes'}</b>
        </div>)}
        {distances.has(0)&&<div className={selectedWindow!==null?'muted':''}><span className="route-map-legend-line" style={{backgroundColor:legColor(0)}} aria-hidden="true"/>
          <span>Outside leg actions</span><b>{miles(distances.get(0)!)}</b></div>}
      </div>}
      <figcaption>{history?'Recorded':'Live'} route · {visiblePoints.length.toLocaleString()} of {points.length.toLocaleString()} saved GPS fixes shown · {gaps} reporting gap{gaps===1?'':'s'}.
        {matched&&!raw?' Colored lines follow streets matched to recorded coordinates.':' Colored lines follow raw recorded coordinates.'}
        {match.data?.value.status==='PENDING'?' Aligning the drive to streets…':''}
        {match.data?.value.status==='PARTIAL'?' Some sections could not be road-matched. Use raw GPS to inspect them.':''}
        {match.data?.value.status==='UNAVAILABLE'||match.isError?' Street matching is unavailable; raw GPS remains visible.':''}
        {full.data?.value.truncated?' This trace exceeded the 100,000-fix display limit.':''}
        {history?' Between-leg waiting is not drawn as travel.':''} The map never joins reporting gaps; Google Maps may calculate a different suggested route.</figcaption>
    </figure>
    {tileError&&<p role="alert">Some street tiles could not load. Pan or zoom to retry.</p>}
  </div>;
}
