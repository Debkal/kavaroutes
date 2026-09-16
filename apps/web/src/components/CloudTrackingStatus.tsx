import {useQuery} from '@tanstack/react-query';
import type {createCloudApi} from '../cloud-api';
import {CloudReturnReview} from './CloudReturnReview';
type Api=ReturnType<typeof createCloudApi>;
export function CloudTrackingStatus({api,day,enabled}:{api:Api;day:string;enabled:boolean}){
 const shifts=useQuery({queryKey:['private-cloud','dispatch-tracking-shifts',day],queryFn:()=>api.dispatchSnapshot(day),enabled,retry:false,refetchInterval:5000});
 return <section aria-label="Driver transmission status"><h2>Driver transmission status</h2><p>Synthetic tracking only. A transmission gap does not identify its cause.</p>
  {shifts.isError&&<p role="alert">Dispatch connection unavailable. Tracking status cannot be verified; this does not prove a driver lost signal.</p>}
  {!shifts.isError&&shifts.data?.value.resources.filter(r=>r.kind==='driver-shift').map((r,i)=><ShiftStatus key={r.reference} api={api} shift={r.reference.slice('driver-shift:'.length)} index={i+1} enabled={enabled}/>)}
 </section>;
}
function ShiftStatus({api,shift,index,enabled}:{api:Api;shift:string;index:number;enabled:boolean}){
 const view=useQuery({queryKey:['private-cloud','dispatch-tracking',shift],queryFn:()=>api.shiftStatus(shift),enabled,retry:false,refetchInterval:5000});
 if(view.isError)return <article><h3>Shift {index}</h3><p role="alert">Tracking status unavailable. Last displayed data is not current. Check the Dispatch connection and contact the driver if needed.</p></article>;
 const t=view.data?.value.tracking;
 if(!t)return <p role="status">Loading shift {index} tracking status…</p>;
 const title=t.status==='UPDATES_OVERDUE'||t.status==='NO_UPDATES'?'Updates overdue — contact driver':t.status==='TRACKING_STOPPED'?'Location sharing stopped — contact driver':t.status==='UPDATES_CURRENT'?'Recent synthetic update received':t.status==='SHIFT_ENDED'?'Shift ended — collection stopped':t.status==='WAITING_FOR_FIRST_UPDATE'?'Waiting for first update':'Tracking status needs review';
 return <article><h3>Shift {index}: {title}</h3>
  <p role={t.contactDriver?'alert':'status'}>{t.contactDriver?'Contact the driver to confirm their status. No automatic call is placed.':'No transmission warning.'}</p>
  <dl><dt>Last received by server</dt><dd>{t.lastReceivedAt??'No update received'}</dd><dt>Last sample captured</dt><dd>{t.lastCapturedAt??'No sample'}</dd><dt>Last evaluated</dt><dd>{t.evaluatedAt}</dd><dt>Reason</dt><dd>{t.reason.replaceAll('_',' ')}</dd></dl>
  <p>Updates become overdue after {t.staleAfterSeconds} seconds. A delayed batch is not live tracking.</p>
  <CloudReturnReview api={api} shift={shift}/>
 </article>;
}
