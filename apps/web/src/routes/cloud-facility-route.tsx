import {useEffect,useMemo,useState} from 'react';
import {useQuery} from '@tanstack/react-query';
import type {LoaderFunctionArgs} from 'react-router';
import {createCloudFacilityApi} from '../cloud-facility-api';
import {queryClient} from '../runtime';
import {businessToday,businessTime} from '../business-time';
import {ServiceDatePicker} from '../components/ServiceDatePicker';
const context=['private-cloud','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','facility','30000000-0000-4000-8000-000000000002','FACILITY_COORDINATION'] as const;
export function loader({request}:LoaderFunctionArgs){if(new URL(request.url).search)throw new Response('Invalid client context',{status:400});queryClient.clear();return null;}
export function Component(){const api=useMemo(()=>createCloudFacilityApi(window.location.origin,window.fetch.bind(window)),[]);
 const [day,setDay]=useState(()=>businessToday()),[after,setAfter]=useState<string|null>(null),[selected,setSelected]=useState<string|null>(null);
 const session=useQuery({queryKey:[...context,'session'],queryFn:({signal})=>api.authenticate(signal),retry:false,refetchInterval:15000});
 const page=useQuery({queryKey:[...context,'day',day,after],queryFn:({signal})=>api.day(day,after,signal),enabled:session.isSuccess,retry:false,refetchInterval:5000});
 const detail=useQuery({queryKey:[...context,'trip',selected],queryFn:({signal})=>api.trip(selected!,signal),enabled:session.isSuccess&&!!selected,retry:false,refetchInterval:5000});
 useEffect(()=>()=>{void queryClient.cancelQueries({queryKey:context});queryClient.removeQueries({queryKey:context});},[]);
 return <main id="main-content" className="facility-page"><h1>Clients</h1><p>KavaRoutes Connect · private synthetic client list. This view requests only granted trip status and scheduled time. No live position or ETA is provided.</p>
 {session.isError?<p role="alert">Client session unavailable. No previous trip data is shown.</p>:session.isPending?<p role="status">Checking client access…</p>:<>
 <ServiceDatePicker value={day} onChange={value=>{setDay(value);setAfter(null);setSelected(null);}}/>
 <button onClick={()=>{void page.refetch();if(selected)void detail.refetch();}}>Refresh client trips</button>
 {page.isError?<p role="alert">Client trips unavailable. Previous data is not current.</p>:page.isPending?<p role="status">Loading client trips…</p>:<><ul>{page.data.value.items.map((trip,i)=><li key={trip.relatedTripReference}><strong>Trip {i+1}</strong> · {trip.lifecycle.replaceAll('_',' ')} · Scheduled: <time dateTime={trip.scheduledAt}>{businessTime(trip.scheduledAt)}</time> <button onClick={()=>setSelected(trip.relatedTripReference)}>View trip {i+1}</button></li>)}</ul>{page.data.value.items.length===0&&<p>No granted trips for this page.</p>}
 <button disabled={!after} onClick={()=>{setAfter(null);setSelected(null);}}>First page</button><button disabled={!page.data.value.nextAfter} onClick={()=>{setAfter(page.data.value.nextAfter);setSelected(null);}}>Next page</button></>}
 {selected&&<section aria-label="Selected client trip"><h2>Trip status</h2>{detail.isError?<p role="alert">Trip no longer available to this client. Previous details are hidden.</p>:detail.isPending?<p role="status">Loading trip status…</p>:<p>{detail.data.value.lifecycle.replaceAll('_',' ')} · Scheduled: {businessTime(detail.data.value.scheduledAt)}</p>}<button onClick={()=>setSelected(null)}>Close trip details</button></section>}
 </>}</main>;
}
