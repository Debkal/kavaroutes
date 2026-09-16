import {useEffect,useRef,useState} from 'react';
import {useQuery} from '@tanstack/react-query';
import {DevelopmentApiError} from '@kavaroutes/api-contracts/private-development-transport';
import type {createCloudApi} from '../cloud-api';
import type {CloudAssignmentCommand} from '../cloud-board-contract';
import {connectCloudDispatch} from '../cloud-live';
import {CloudRouteReview} from './CloudRouteReview';
import {CloudTrackingStatus} from './CloudTrackingStatus';

export function CloudBoard({api,enabled}:{api:ReturnType<typeof createCloudApi>;enabled:boolean}){
 const [day,setDay]=useState('2026-09-14'),[filter,setFilter]=useState('all'),[selected,setSelected]=useState('');
 const [driver,setDriver]=useState(''),[vehicle,setVehicle]=useState(''),[message,setMessage]=useState(''),[live,setLive]=useState('connecting'),[busy,setBusy]=useState(false);
 const pending=useRef<CloudAssignmentCommand|null>(null),flight=useRef(false);
 const board=useQuery({queryKey:['private-cloud','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','dispatch','ASSIGNED_SERVICE_DELIVERY',day],queryFn:({signal})=>api.board(day,signal),enabled,retry:false,refetchInterval:5000});
 const refresh=useRef(async()=>{});refresh.current=async()=>{const result=await board.refetch();if(result.isError)throw new Error('BOARD_REFRESH_FAILED');};
 useEffect(()=>{
  if(!enabled)return;
  return connectCloudDispatch({origin:window.location.origin,serviceDate:day,snapshot:async()=>(await api.dispatchSnapshot(day)).value.cursor,refresh:()=>refresh.current(),status:setLive});
 },[api,enabled,day]);
 useEffect(()=>{
  const warn=(event:BeforeUnloadEvent)=>{if(pending.current){event.preventDefault();event.returnValue='';}};
  window.addEventListener('beforeunload',warn);return()=>window.removeEventListener('beforeunload',warn);
 },[]);
 const data=board.data?.value,run=data?.runs.find(r=>r.runId===selected);
 const choose=(id:string)=>{if(pending.current||flight.current)return;const item=data?.runs.find(r=>r.runId===id);setSelected(id);setDriver(item?.driverId??'');setVehicle(item?.vehicleId??'');setMessage('');};
 const assign=async()=>{
  if(flight.current||!run||!data||board.isError)return;
  if(!pending.current){
   if(!driver||!vehicle)return;
   if(!window.confirm('Commit this driver and vehicle assignment? The server will recheck availability and safety constraints.'))return;
   pending.current={runId:run.runId,expectedVersion:run.version,expectedTag:run.expectedTag,driverId:driver,vehicleId:vehicle,key:`web-assign-${crypto.randomUUID()}`};
  }
  flight.current=true;setBusy(true);setMessage('Submitting assignment…');
  try{
   const receipt=await api.assign(pending.current);pending.current=null;
   setMessage('Accepted; refreshing the authoritative board…');
   const next=await board.refetch();
   const committed=next.data?.value.runs.find(r=>r.runId===receipt.value.runId);
   if(next.isError||!committed||committed.version<receipt.value.version)setMessage('Assignment accepted; projection recovery required. Refresh from server.');
   else if(committed.assignmentId!==receipt.value.assignmentId)setMessage('Assignment accepted, then changed by another dispatcher. Review the current board.');
   else setMessage('Assignment confirmed by the server. Driver itinerary updated.');
  }catch(error){
   if(error instanceof DevelopmentApiError && error.status>=400 && error.status<500 && error.code!=='OUTCOME_UNKNOWN'){
    pending.current=null;setMessage(error.code==='VERSION_CONFLICT'?'Conflict. Refresh and review before assigning again.':'Assignment rejected. Review driver, vehicle and run constraints.');await board.refetch();
   }else setMessage('Outcome unknown. Retry the original assignment here, or use Command recovery after reloading. Do not create a replacement.');
  }finally{flight.current=false;setBusy(false);}
 };
 return <section aria-label="Cloud dispatch board">
  <h2>Dispatch board</h2><p>Private synthetic service day. Map unavailable; all assignments and stops remain usable below.</p>
  <label>Service date <input type="date" value={day} disabled={busy||!!pending.current} onChange={e=>{if(/^\d{4}-\d{2}-\d{2}$/.test(e.target.value)){setDay(e.target.value);setSelected('');}}}/></label>
  <label>Assignments <select value={filter} onChange={e=>setFilter(e.target.value)}><option value="all">All runs</option><option value="assigned">Assigned</option><option value="unassigned">Unassigned</option></select></label>
  <button disabled={!enabled||busy} onClick={()=>void board.refetch()}>Refresh dispatch board</button>
  <p role="status">Dispatch updates: {live}. {data?.runs.length??0} runs.</p>
  {board.isPending&&<p role="status">Loading dispatch board…</p>}
  {board.isError&&<p role="alert">Dispatch unavailable. Previous data is stale; assignment controls are blocked.</p>}
  {data&&<><table><caption>Runs in planned start order</caption><thead><tr><th>Run</th><th>Start</th><th>State</th><th>Driver</th><th>Vehicle</th><th>Details</th></tr></thead><tbody>
   {data.runs.filter(r=>filter==='all'||(filter==='assigned'?!!r.assignmentId:!r.assignmentId)).map((r,index)=><tr key={r.runId}><th scope="row">Run {index+1}</th><td>{new Date(r.plannedStartAt).toLocaleTimeString('en-US',{timeZone:r.serviceTimezone,hour:'2-digit',minute:'2-digit'})}</td><td>{r.lifecycle}</td><td>{data.drivers.find(d=>d.id===r.driverId)?.label??'Unassigned'}</td><td>{data.vehicles.find(v=>v.id===r.vehicleId)?.label??'Unassigned'}</td><td><button disabled={busy||!!pending.current} aria-pressed={selected===r.runId} onClick={()=>choose(r.runId)}>View run {index+1}</button></td></tr>)}
  </tbody></table>{!data.runs.length&&<p>No runs for this service day.</p>}</>}
  {run&&data&&<section aria-label="Selected run"><h3>Run details · version {run.version}</h3>
   <ol>{data.legs.filter(l=>l.runId===run.runId).map(l=><li key={l.tripLegId}>{l.riderLabel}: {l.pickupLabel} → {l.dropoffLabel} · {l.lifecycle} · trip {l.tripState}</li>)}</ol>
   <label>Driver <select value={driver} disabled={busy||!!pending.current} onChange={e=>setDriver(e.target.value)}><option value="">Choose driver</option>{data.drivers.map(d=><option key={d.id} value={d.id}>{d.label}</option>)}</select></label>
   <label>Vehicle <select value={vehicle} disabled={busy||!!pending.current} onChange={e=>setVehicle(e.target.value)}><option value="">Choose vehicle</option>{data.vehicles.map(v=><option key={v.id} value={v.id}>{v.label}</option>)}</select></label>
   <button disabled={busy||board.isError||!driver||!vehicle} onClick={()=>void assign()}>{pending.current?'Recover original assignment':'Confirm assignment'}</button>
   <p>Availability, capacity, qualifications, critical defects and started work are rechecked by the backend.</p>
  </section>}
  <p role="status">{message}</p>
  <CloudRouteReview api={api} day={day} enabled={enabled}/>
  <CloudTrackingStatus api={api} day={day} enabled={enabled}/>
  {pending.current&&<p>The server retains the original command. After reloading, use Command recovery to review its receipt before submitting another assignment.</p>}
 </section>;
}
