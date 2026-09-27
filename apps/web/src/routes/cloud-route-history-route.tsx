import {useMemo} from 'react';
import {useQuery} from '@tanstack/react-query';
import {useSearchParams} from 'react-router';
import {createCloudApi} from '../cloud-api';
import {businessToday} from '../business-time';
import {ServiceDatePicker} from '../components/ServiceDatePicker';
import {DispatchRouteHistory} from '../components/DispatchRouteHistory';

export function Component(){
  const api=useMemo(()=>createCloudApi(window.location.origin,window.fetch.bind(window)),[]);
  const [search,setSearch]=useSearchParams();
  const requested=search.get('date');
  const day=requested&&/^\d{4}-\d{2}-\d{2}$/.test(requested)&&Number.isFinite(Date.parse(`${requested}T12:00:00Z`))?requested:businessToday();
  const session=useQuery({queryKey:['private-cloud','session'],queryFn:({signal})=>api.authenticate(signal),retry:false});
  return <main id="main-content" className="dispatch-page route-history-page">
    <section className="page-title"><div><p className="eyebrow">KavaRoutes Dispatch</p><h1>Route history</h1><p>Review completed driver shifts, their recorded GPS traces, and gaps in location reporting.</p></div>
      <span className={`dispatch-connection ${session.isSuccess?'ready':session.isError?'error':'connecting'}`}>{session.isSuccess?'History connected':session.isError?'History unavailable':'Connecting…'}</span></section>
    <section className="workspace-card" aria-label="Route history service date"><ServiceDatePicker value={day} onChange={next=>setSearch({date:next})}/></section>
    <DispatchRouteHistory api={api} day={day} enabled={session.isSuccess}/>
    {session.isError&&<p role="alert">Route history cannot reach the server. Check your connection and sign-in.</p>}
  </main>;
}
