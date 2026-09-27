import type {ReactNode} from 'react';
import {useQuery} from '@tanstack/react-query';
import type {createCloudApi} from '../cloud-api';

type Api=ReturnType<typeof createCloudApi>;
type Track=Awaited<ReturnType<Api['tracking']>>['value']['shifts'][number];

/** A map is requested only for the selected shift. Live positioning refreshes the
 * image at most once per newly captured minute; the detailed GPS log remains local. */
export function RouteStreetMap({api,day,track,clientId=null,history=false,fallback}:{
  api:Api;day:string;track:Track;clientId?:string|null;history?:boolean;fallback:ReactNode;
}){
  const hasFixes=track.trace.length>0;
  const revision=track.lastCapturedAt?Math.floor(Date.parse(track.lastCapturedAt)/60_000):0;
  const map=useQuery({queryKey:['private-cloud','dispatch-trace-map',day,track.shiftReference,clientId,revision],
    queryFn:()=>api.routeTraceMap(day,track.shiftReference,clientId),enabled:hasFixes,staleTime:30*60_000,retry:false});
  if(!hasFixes)return <>{fallback}</>;
  if(map.isPending)return <p role="status">Loading street map for the recorded GPS fixes…</p>;
  const image=map.data?.value.mapImageUrl;
  if(map.isError||!image)return <><p role="status">Street map unavailable for this trace. The saved GPS plot remains below.</p>{fallback}</>;
  return <figure className="route-street-map">
    <img src={image} width="900" height="500" alt={`${track.driverLabel}: street map with ${map.data.value.fixCount} recorded GPS fixes, first and last positions marked; gaps over 90 seconds are not connected.`}/>
    <figcaption>{history?'Recorded':'Live'} GPS fixes on streets · S is the first visible fix, E is the last. Gaps over 90 seconds are left open; the line follows reported GPS positions and is not snapped to roads. <a href="https://www.geoapify.com/" target="_blank" rel="noreferrer">Powered by Geoapify</a> · <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">© OpenStreetMap contributors</a></figcaption>
  </figure>;
}
