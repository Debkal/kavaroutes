import {useEffect,useRef,useState} from 'react';
import {useQuery} from '@tanstack/react-query';
import {DevelopmentApiError} from '@kavaroutes/api-contracts/private-development-transport';
import type {createCloudApi} from '../cloud-api';
import type {CloudAssignmentCommand} from '../cloud-board-contract';
import {connectCloudDispatch} from '../cloud-live';
import {CloudRouteReview} from './CloudRouteReview';
import {businessToday} from '../business-time';
import {ServiceDatePicker} from './ServiceDatePicker';

import {dispatchCommandMessage} from '../command-refusal';
import {dispatchDayRows,downloadCsv} from '../csv';

export function CloudBoard({api,enabled,serviceDate,onServiceDateChange,focusRunId=null,onFocusRunHandled}:{api:ReturnType<typeof createCloudApi>;enabled:boolean;serviceDate?:string;onServiceDateChange?:(value:string)=>void;focusRunId?:string|null;onFocusRunHandled?:()=>void}){
 const [localDay,setLocalDay]=useState(()=>businessToday()),[filter,setFilter]=useState('all'),[selected,setSelected]=useState('');
 const day=serviceDate??localDay;
 const changeDay=(value:string)=>{if(!/^\d{4}-\d{2}-\d{2}$/.test(value))return;(onServiceDateChange??setLocalDay)(value);setSelected('');setDriver('');setVehicle('');setMessage('');};
 const [driver,setDriver]=useState(''),[vehicle,setVehicle]=useState(''),[message,setMessage]=useState(''),[live,setLive]=useState('connecting'),[busy,setBusy]=useState(false);
 const pending=useRef<CloudAssignmentCommand|null>(null),flight=useRef(false);
 const [releasePending,setReleasePending]=useState<{runId:string;expectedVersion:number;expectedTag:string;key:string}|null>(null);
 const detailRef=useRef<HTMLElement|null>(null);
 const refreshedFocus=useRef<string|null>(null);
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
 const choose=(id:string,scroll=true)=>{if(pending.current||flight.current)return;const item=data?.runs.find(r=>r.runId===id);setSelected(id);setDriver(item?.driverId??'');setVehicle(item?.vehicleId??'');setMessage('');if(scroll)window.setTimeout(()=>{detailRef.current?.scrollIntoView?.({behavior:'smooth',block:'start'});detailRef.current?.focus({preventScroll:true});},0);};
 useEffect(()=>{
  if(!focusRunId)return;
  const item=data?.runs.find(candidate=>candidate.runId===focusRunId);
  if(!item){
   if(refreshedFocus.current!==focusRunId){refreshedFocus.current=focusRunId;void board.refetch();}
   return;
  }
  refreshedFocus.current=null;
  setSelected(focusRunId);setDriver(item.driverId??'');setVehicle(item.vehicleId??'');setMessage('');
  window.setTimeout(()=>{detailRef.current?.scrollIntoView?.({behavior:'smooth',block:'start'});detailRef.current?.focus({preventScroll:true});},0);
  onFocusRunHandled?.();
 },[focusRunId,data,onFocusRunHandled]);
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
    pending.current=null;setMessage(dispatchCommandMessage(error,'Assignment rejected. Review driver, vehicle and run constraints.'));await board.refetch();
   }else setMessage('Outcome unknown. Retry the original assignment here, or use Command recovery after reloading. Do not create a replacement.');
  }finally{flight.current=false;setBusy(false);}
 };
 const release=async()=>{
  if(flight.current||!run||!data||board.isError)return;
  if(!window.confirm('Remove this driver and vehicle from the run? The run stays planned and can take another assignment.'))return;
  const command=releasePending??{runId:run.runId,expectedVersion:run.version,expectedTag:run.expectedTag,key:`web-release-${crypto.randomUUID()}`};
  setReleasePending(command);
  flight.current=true;setBusy(true);setMessage('Removing the driver and vehicle…');
  try{
   const receipt=await api.unassignRun(command.runId,command.expectedVersion,command.expectedTag,command.key);
   setReleasePending(null);
   setMessage(`Driver and vehicle removed at version ${receipt.value.version}. The run is unassigned.`);
   await board.refetch();
  }catch(error){
   if(error instanceof DevelopmentApiError&&error.status>=400&&error.status<500&&error.code!=='OUTCOME_UNKNOWN'){
    setReleasePending(null);setMessage(dispatchCommandMessage(error,'Assignment rejected. Review driver, vehicle and run constraints.'));await board.refetch();
   }else setMessage('Outcome unknown. Retry the same removal, or refresh the board before doing anything else.');
  }finally{flight.current=false;setBusy(false);}
 };
 const visibleRuns=data?.runs.filter(r=>filter==='all'||(filter==='assigned'?!!r.assignmentId:!r.assignmentId))??[];
 const assignedCount=data?.runs.filter(item=>item.assignmentId).length??0;
 const primaryLeg=run&&data?.legs.find(item=>item.runId===run.runId);
 const assignmentUnchanged=!!run?.assignmentId&&driver===run.driverId&&vehicle===run.vehicleId;
 // One sheet with the day's counts and every trip's appointment / planned wait, so the
 // exported workbook reconciles waiting time without a second manual pass.
 const exportDay=()=>{
  if(!data)return;
  downloadCsv(`kavaroutes-dispatch-${day}.csv`,dispatchDayRows({day,runs:data.runs,legs:data.legs,drivers:data.drivers,vehicles:data.vehicles}));
 };
 return <section id="dispatch-operations" className="workspace-card dispatch-board" aria-label="Cloud dispatch board">
  <div className="section-heading"><div><p className="eyebrow">Operations</p><h2>Assign and manage today’s runs</h2><p>Select a run to review its stops, driver, and vehicle.</p></div><span className={`dispatch-live ${live}`}>{live}</span></div>
  <ServiceDatePicker value={day} disabled={busy||!!pending.current} onChange={changeDay}/>
  <p className="dispatch-summary" aria-label="Run summary"><span><strong>{data?.runs.length??0}</strong> runs</span><span><strong>{assignedCount}</strong> assigned</span><span><strong>{(data?.runs.length??0)-assignedCount}</strong> need a driver</span></p>
  <div className="dispatch-toolbar"><label>Show <select value={filter} onChange={e=>setFilter(e.target.value)}><option value="all">All runs</option><option value="assigned">Assigned</option><option value="unassigned">Need assignment</option></select></label>
  <div><button disabled={!enabled||busy} onClick={()=>void board.refetch()}>Refresh runs</button><button disabled={!data?.legs.length} onClick={exportDay}>Export day CSV</button></div></div>
  <p role="status" className="sr-status">Dispatch updates: {live}. {data?.runs.length??0} runs.</p>
  {board.isPending&&<p role="status">Loading dispatch board…</p>}
  {board.isError&&<p role="alert">Dispatch unavailable. Previous data is stale; assignment controls are blocked.</p>}
  {data&&<><div className="table-scroll dispatch-table" tabIndex={0} role="group" aria-label="Runs table, scrollable"><table><caption>Runs in planned start order</caption><thead><tr><th>Client / run</th><th>Start</th><th>Appointment / wait</th><th>State</th><th>Driver</th><th>Vehicle</th><th>Action</th></tr></thead><tbody>
   {visibleRuns.map((r,index)=>{const leg=data.legs.find(item=>item.runId===r.runId);return <tr key={r.runId} className={selected===r.runId?'selected-row':''}><th scope="row">{leg?.riderLabel??`Run ${index+1}`}<small>{leg?`${leg.pickupLabel} → ${leg.dropoffLabel}`:`Run ${index+1}`}</small></th><td>{new Date(r.plannedStartAt).toLocaleTimeString('en-US',{timeZone:r.serviceTimezone,hour:'numeric',minute:'2-digit'})}</td><td>{leg?`${leg.appointmentLengthMinutes} min`:'—'}</td><td><span className={r.assignmentId?'status status-completed':'status status-late'}>{r.assignmentId?'Assigned':'Needs assignment'}</span></td><td>{data.drivers.find(d=>d.id===r.driverId)?.label??'—'}</td><td>{data.vehicles.find(v=>v.id===r.vehicleId)?.label??'—'}</td><td><button className={r.assignmentId?'':'primary'} disabled={busy||!!pending.current} aria-pressed={selected===r.runId} onClick={()=>choose(r.runId)}>{r.assignmentId?'Manage':'Assign driver'}</button></td></tr>})}
  </tbody></table></div>{!visibleRuns.length&&<p>No runs match this filter for the selected day.</p>}</>}
  {run&&data&&<section ref={detailRef} tabIndex={-1} className="selected-run-panel" aria-label="Selected run"><div className="selected-run-heading"><div><p className="eyebrow">Selected run</p><h3>{primaryLeg?.riderLabel??'Run details'}</h3><p>{primaryLeg?`${primaryLeg.pickupLabel} → ${primaryLeg.dropoffLabel}`:`Version ${run.version}`}</p></div><span className={run.assignmentId?'status status-completed':'status status-late'}>{run.assignmentId?'Assigned':'Needs assignment'}</span></div>
   <ol className="run-stops">{data.legs.filter(l=>l.runId===run.runId).map((l,index)=><li key={l.tripLegId}><span>{index+1}</span><div><strong>{l.riderLabel}</strong><small>{l.pickupLabel} → {l.dropoffLabel} · {l.appointmentLengthMinutes} min appointment / planned wait</small></div><em>{l.lifecycle.replaceAll('_',' ')}</em></li>)}</ol>
   <div className="assignment-controls"><label>Driver <select value={driver} disabled={busy||!!pending.current} onChange={e=>setDriver(e.target.value)}><option value="">Choose driver</option>{data.drivers.map(d=><option key={d.id} value={d.id}>{d.label}</option>)}</select></label>
   <label>Vehicle <select value={vehicle} disabled={busy||!!pending.current} onChange={e=>setVehicle(e.target.value)}><option value="">Choose vehicle</option>{data.vehicles.map(v=><option key={v.id} value={v.id}>{v.label}</option>)}</select></label></div>
   <div className="assignment-actions"><button className="primary" disabled={busy||board.isError||!driver||!vehicle||assignmentUnchanged} onClick={()=>void assign()}>{pending.current?'Retry original assignment':run.assignmentId?'Save assignment change':'Assign driver and vehicle'}</button>
   {run.assignmentId&&<button disabled={busy||board.isError} onClick={()=>void release()}>{releasePending?'Retry original removal':'Remove assignment'}</button>}
   <a className="action-link" href="/command#driver-access">Manage driver accounts</a></div>
   <p className="form-hint">The server rechecks availability, vehicle capacity, qualifications, defects, and started work before accepting an assignment.</p>
  </section>}
  <p role="status">{message}</p>
  <CloudRouteReview api={api} day={day} enabled={enabled}/>
  {pending.current&&<p>The server retains the original command. After reloading, use Command recovery to review its receipt before submitting another assignment.</p>}
 </section>;
}
