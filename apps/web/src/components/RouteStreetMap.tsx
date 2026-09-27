import {useEffect,useRef,useState,type KeyboardEvent,type PointerEvent,type ReactNode} from 'react';
import {useQuery} from '@tanstack/react-query';
import type {createCloudApi} from '../cloud-api';
import {fitTraceView,panTraceView,zoomTraceView,type MapView} from '../route-map-view';
import {googleMapsRouteUrl} from '../route-trace-export';

type Api=ReturnType<typeof createCloudApi>;
type Track=Awaited<ReturnType<Api['tracking']>>['value']['shifts'][number];

/** One authorized image per selected view. The map key and GPS request stay on
 * the server; dragging or pressing a control requests one newly rendered view. */
export function RouteStreetMap({api,day,track,clientId=null,history=false,fallback}:{
  api:Api;day:string;track:Track;clientId?:string|null;history?:boolean;fallback:ReactNode;
}){
  const [view,setView]=useState<MapView|null>(null);
  const drag=useRef<{x:number;y:number}|null>(null);
  useEffect(()=>setView(null),[day,track.shiftReference,clientId]);
  const hasFixes=track.trace.length>0;
  const fit=hasFixes?fitTraceView(track.trace):null;
  const current=view??fit;
  const revision=track.lastCapturedAt?Math.floor(Date.parse(track.lastCapturedAt)/60_000):0;
  const map=useQuery({queryKey:['private-cloud','dispatch-trace-map',day,track.shiftReference,clientId,revision,view],
    queryFn:()=>api.routeTraceMap(day,track.shiftReference,clientId,view),enabled:hasFixes,staleTime:30*60_000,retry:false,
    placeholderData:previous=>previous});
  if(!hasFixes||!current)return <>{fallback}</>;
  const move=(dx:number,dy:number,width=900,height=500)=>setView(panTraceView(current,dx,dy,width,height));
  const pointerDown=(event:PointerEvent<HTMLDivElement>)=>{
    if(event.button!==0)return;
    drag.current={x:event.clientX,y:event.clientY};event.currentTarget.setPointerCapture?.(event.pointerId);
  };
  const pointerUp=(event:PointerEvent<HTMLDivElement>)=>{
    const start=drag.current;drag.current=null;if(!start)return;
    const dx=event.clientX-start.x,dy=event.clientY-start.y;
    if(Math.abs(dx)+Math.abs(dy)<6)return;
    const rect=event.currentTarget.getBoundingClientRect();move(dx,dy,rect.width,rect.height);
  };
  const keyDown=(event:KeyboardEvent<HTMLDivElement>)=>{
    const arrows:Record<string,[number,number]>={ArrowLeft:[120,0],ArrowRight:[-120,0],ArrowUp:[0,120],ArrowDown:[0,-120]};
    if(event.key in arrows){event.preventDefault();move(...arrows[event.key]!);}
    else if(event.key==='+'||event.key==='='){event.preventDefault();setView(zoomTraceView(current,1));}
    else if(event.key==='-'){event.preventDefault();setView(zoomTraceView(current,-1));}
  };
  const googleUrl=googleMapsRouteUrl(track.trace);
  const image=map.data?.value.mapImageUrl;
  return <div className="route-map-wrap">
    <div className="route-map-controls" role="group" aria-label="Street map controls">
      <button type="button" aria-label="Zoom in street map" disabled={current.zoom>=19} onClick={()=>setView(zoomTraceView(current,1))}>+</button>
      <button type="button" aria-label="Zoom out street map" disabled={current.zoom<=4} onClick={()=>setView(zoomTraceView(current,-1))}>−</button>
      <button type="button" onClick={()=>setView(null)} disabled={!view}>Fit route</button>
      {googleUrl&&<a href={googleUrl} target="_blank" rel="noopener noreferrer">Open approximate directions in Google Maps</a>}
    </div>
    {map.isPending?<p role="status">Loading street map for the recorded GPS fixes…</p>
      :map.isError||!image?<><p role="status">Street map unavailable for this trace. The saved GPS plot remains below.</p>{fallback}</>
        :<figure className="route-street-map">
          <div className="route-street-viewport" role="region" aria-label="Street map: drag to pan, use plus or minus to zoom, arrow keys to pan" tabIndex={0}
            onPointerDown={pointerDown} onPointerUp={pointerUp} onPointerCancel={()=>{drag.current=null;}} onKeyDown={keyDown}>
            <img src={image} width="900" height="500" draggable={false} alt={`${track.driverLabel}: street map with ${map.data.value.fixCount} recorded GPS fixes, first and last positions marked; gaps over 90 seconds are not connected.`}/>
          </div>
          <figcaption>{history?'Recorded':'Live'} GPS fixes on streets · Drag to pan or use +/− to zoom. S is the first visible fix, E is the last. Gaps over 90 seconds are left open; the line follows reported GPS positions and is not snapped to roads. Google Maps recalculates directions and may show a different path. <a href="https://www.geoapify.com/" target="_blank" rel="noreferrer">Powered by Geoapify</a> · <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">© OpenStreetMap contributors</a></figcaption>
        </figure>}
    {map.isFetching&&!map.isPending&&<p role="status">Updating map view…</p>}
  </div>;
}
