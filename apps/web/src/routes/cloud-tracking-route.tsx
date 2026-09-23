import {useMemo,useState} from 'react';
import {useQuery} from '@tanstack/react-query';
import {createCloudApi} from '../cloud-api';
import {businessToday} from '../business-time';
import {CloudTrackingStatus} from '../components/CloudTrackingStatus';
import {ServiceDatePicker} from '../components/ServiceDatePicker';

export function Component(){
  const api=useMemo(()=>createCloudApi(window.location.origin,window.fetch.bind(window)),[]);
  const [serviceDate,setServiceDate]=useState(()=>businessToday());
  const session=useQuery({queryKey:['private-cloud','session'],queryFn:({signal})=>api.authenticate(signal),retry:false});
  return <main id="main-content" className="dispatch-page tracking-page">
    <section className="page-title"><div><p className="eyebrow">KavaRoutes Dispatch</p><h1>Active drivers</h1><p>See drivers on shift, their latest saved position, and whether they need contact.</p></div>
      <span className={`dispatch-connection ${session.isSuccess?'ready':session.isError?'error':'connecting'}`}>{session.isSuccess?'Tracking connected':session.isError?'Tracking unavailable':'Connecting…'}</span></section>
    <section className="workspace-card" aria-label="Tracking service date"><ServiceDatePicker value={serviceDate} onChange={setServiceDate}/></section>
    <CloudTrackingStatus api={api} day={serviceDate} enabled={session.isSuccess}/>
    {session.isPending&&<p role="status">Connecting to tracking…</p>}
    {session.isError&&<p role="alert">Tracking cannot reach the server. Driver positions are unavailable.</p>}
  </main>;
}
