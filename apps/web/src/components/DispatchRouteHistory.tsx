import {useState} from 'react';
import {Link} from 'react-router';
import {useQuery} from '@tanstack/react-query';
import type {createCloudApi} from '../cloud-api';
import {TracePlot} from './DispatchDriverTracking';
import {RouteStreetMap} from './RouteStreetMap';
import {shiftBandLabel} from '../shift-band';
import {downloadCsv} from '../csv';
import {routeHistoryRows} from '../route-history-csv';

type Api=ReturnType<typeof createCloudApi>;
type Track=Awaited<ReturnType<Api['tracking']>>['value']['shifts'][number];
type Event=Awaited<ReturnType<Api['routeHistory']>>['value']['events'][number];
const stamp=(value:string|null,zone:string)=>value?new Date(value).toLocaleString('en-US',{timeZone:zone,month:'short',day:'numeric',hour:'numeric',minute:'2-digit',second:'2-digit',timeZoneName:'short'}):'Not recorded';
const label=(value:string)=>value.replaceAll('_',' ').toLowerCase().replace(/\b\w/g,letter=>letter.toUpperCase());
const applied=(events:readonly Event[],legId:string,action:string)=>events.find(event=>event.tripLegId===legId&&event.kind==='DRIVER_ACTION'&&event.action===action&&event.outcome==='APPLIED')??null;
const gapSeconds=(current:Track['trace'][number],previous:Track['trace'][number]|undefined)=>previous?Math.max(0,Math.round((Date.parse(current.capturedAt)-Date.parse(previous.capturedAt))/1000)):0;

export function DispatchRouteHistory({api,day,enabled}:{api:Api;day:string;enabled:boolean}){
  const [selected,setSelected]=useState<string|null>(null),[driverId,setDriverId]=useState(''),[clientId,setClientId]=useState('');
  const tracks=useQuery({queryKey:['private-cloud','dispatch-route-tracks',day],queryFn:()=>api.tracking(day),enabled,retry:false});
  const board=useQuery({queryKey:['private-cloud','dispatch-route-board',day],queryFn:()=>api.board(day),enabled,retry:false});
  const history=useQuery({queryKey:['private-cloud','dispatch-route-events',day],queryFn:()=>api.routeHistory(day),enabled,retry:false});
  const allCompleted=(tracks.data?.value.shifts??[]).filter(track=>track.lifecycle==='SHIFT_ENDED');
  const events=history.data?.value.events??[];
  const runOf=(shift:string)=>events.find(event=>event.shiftReference===shift&&event.kind==='SHIFT_STARTED')?.runId??null;
  const clientForTrip=new Map((history.data?.value.tripClients??[]).map(item=>[item.tripId,item]));
  const clients=new Map<string,string>();
  for(const track of allCompleted){const runId=runOf(track.shiftReference);
    for(const leg of board.data?.value.legs.filter(item=>item.runId===runId)??[]){const client=clientForTrip.get(leg.tripId);if(client)clients.set(client.clientId,client.clientLabel);}}
  const completed=allCompleted.filter(track=>{
    if(driverId&&track.driverId!==driverId)return false;
    if(!clientId)return true;
    const runId=runOf(track.shiftReference);
    return board.data?.value.legs.some(leg=>leg.runId===runId&&clientForTrip.get(leg.tripId)?.clientId===clientId)??false;
  });
  const detail=completed.find(track=>track.shiftReference===selected)??completed[0]??null;
  const runId=detail?runOf(detail.shiftReference):null;
  const legs=(board.data?.value.legs??[]).filter(leg=>leg.runId===runId&&(!clientId||clientForTrip.get(leg.tripId)?.clientId===clientId));
  const legIds=new Set(legs.map(leg=>leg.tripLegId));
  const detailEvents=events.filter(event=>event.shiftReference===detail?.shiftReference&&(!clientId||event.tripLegId===null||legIds.has(event.tripLegId)));
  const intervals=clientId?legs.flatMap(leg=>{
    const start=['MARK_EN_ROUTE','ARRIVE_PICKUP','BOARD_RIDER'].map(action=>applied(detailEvents,leg.tripLegId,action)).find(Boolean);
    const end=applied(detailEvents,leg.tripLegId,'COMPLETE_LEG')??applied(detailEvents,leg.tripLegId,'MARK_RIDER_NO_SHOW');
    return start?[[Date.parse(start.occurredAt),Date.parse(end?.occurredAt??detail?.lastCapturedAt??start.occurredAt)] as const]:[];
  }):[];
  const trace=detail?(clientId?detail.trace.filter(point=>intervals.some(([start,end])=>Date.parse(point.capturedAt)>=start&&Date.parse(point.capturedAt)<=end)):detail.trace):[];
  const shownTrack=detail?{...detail,trace,position:trace.at(-1)??null}:null;
  const loading=tracks.isPending||board.isPending||history.isPending;
  const failed=tracks.isError||board.isError||history.isError;
  const refresh=()=>{void Promise.all([tracks.refetch(),board.refetch(),history.refetch()]);};
  const exportSelected=()=>{if(!detail||!board.data||!history.data)return;
    downloadCsv(`kavaroutes-route-history-${day}-${detail.shiftReference.slice(0,8)}.csv`,routeHistoryRows({day,track:detail,board:board.data.value,history:history.data.value,trace,legIds:legs.map(leg=>leg.tripLegId)}));};
  return <section id="route-history" className="workspace-card route-history" aria-label="Completed route history">
    <div className="section-heading"><div><p className="eyebrow">Dispatch records</p><h2>Route history</h2>
      <p>Review completed shifts, each trip leg, recorded pickup and drop-off actions, and the GPS trace. Times use the route’s service timezone.</p></div>
      <button type="button" disabled={!enabled||tracks.isFetching||board.isFetching||history.isFetching} onClick={refresh}>Refresh history</button></div>
    {loading&&enabled&&<p role="status">Loading route history for {day}…</p>}
    {failed&&<p role="alert">Some route history data could not load. Retry before relying on this report or exporting it.</p>}
    {history.data?.value.truncated&&<p role="alert">This service day has more than 3,000 recorded events. The event list and CSV are incomplete.</p>}
    <div className="route-history-filters"><label>Driver <select aria-label="Filter route history by driver" value={driverId} onChange={event=>{setDriverId(event.target.value);setSelected(null);}}>
      <option value="">All drivers</option>{[...new Map(allCompleted.map(track=>[track.driverId,track.driverLabel])).entries()].sort((a,b)=>a[1].localeCompare(b[1])).map(([id,name])=><option key={id} value={id}>{name}</option>)}
    </select></label><label>Client <select aria-label="Filter route history by client" value={clientId} disabled={!history.data||!board.data} onChange={event=>{setClientId(event.target.value);setSelected(null);}}>
      <option value="">All clients</option>{[...clients.entries()].sort((a,b)=>a[1].localeCompare(b[1])).map(([id,name])=><option key={id} value={id}>{name}</option>)}
    </select></label></div>
    {!loading&&!failed&&completed.length===0&&<p role="status">No completed shifts match these filters on {day}. An ongoing shift appears in <Link to="/tracking">Active drivers</Link>.</p>}
    {completed.length>0&&<div className="driver-tracking-layout"><div className="driver-tracking-list" aria-label="Completed shift list">
      {completed.map(track=><button type="button" key={track.shiftReference} className={detail?.shiftReference===track.shiftReference?'selected':''}
        aria-pressed={detail?.shiftReference===track.shiftReference} onClick={()=>setSelected(track.shiftReference)}>
        <strong>{track.driverLabel}</strong><span className="status status-completed">Completed</span>
        <small>{track.vehicleLabel??'Vehicle unavailable'} · {shiftBandLabel(track.plannedStartAt,track.serviceTimezone)}</small>
        <small>{track.trace.length} saved fix{track.trace.length===1?'':'es'} · last {stamp(track.lastCapturedAt,track.serviceTimezone)}</small>
      </button>)}</div>
      {detail&&shownTrack&&<article key={detail.shiftReference} className="driver-track route-history-detail">
        <header><div><h3>{detail.driverLabel} · {shiftBandLabel(detail.plannedStartAt,detail.serviceTimezone)}</h3>
          <p>{detail.vehicleLabel??'Vehicle unavailable'} · started {stamp(detail.startedAt,detail.serviceTimezone)} · {detail.serviceTimezone}</p></div>
          <span className="status status-completed">Completed</span></header>
        <button type="button" disabled={!board.data||!history.data||failed} onClick={exportSelected}>Export selected history CSV</button>
        <p className="form-hint">Run {runId??'unavailable'} · {legs.length} trip leg{legs.length===1?'':'s'} shown · {detailEvents.length} recorded event{detailEvents.length===1?'':'s'}.</p>
        <h4>Trip legs</h4>{legs.length===0?<p role="status">No trip legs are linked to this recorded shift.</p>:<ol className="route-history-legs">{legs.map(leg=><li key={leg.tripLegId}>
          <strong>{leg.riderLabel}</strong><span>{clientForTrip.get(leg.tripId)?.clientLabel??'No client account linked'} · {leg.pickupLabel} → {leg.dropoffLabel}</span>
          <span>Planned {stamp(leg.plannedStartAt,detail.serviceTimezone)} to {stamp(leg.plannedEndAt,detail.serviceTimezone)} · {label(leg.lifecycle)}</span>
          <span>Pickup arrival: {stamp(applied(detailEvents,leg.tripLegId,'ARRIVE_PICKUP')?.recordedAt??null,detail.serviceTimezone)} · Boarded: {stamp(applied(detailEvents,leg.tripLegId,'BOARD_RIDER')?.recordedAt??null,detail.serviceTimezone)}</span>
          <span>Drop-off arrival: {stamp(applied(detailEvents,leg.tripLegId,'ARRIVE_DROPOFF')?.recordedAt??null,detail.serviceTimezone)} · Completed: {stamp(applied(detailEvents,leg.tripLegId,'COMPLETE_LEG')?.recordedAt??null,detail.serviceTimezone)}</span>
        </li>)}</ol>}
        <h4>Recorded route events</h4>{detailEvents.length===0?<p>No driver actions are recorded for this shift.</p>:<ol className="route-event-list" aria-label="Recorded route events">{detailEvents.map((event,index)=><li key={`${event.shiftReference}-${index}`}>
          <time dateTime={event.recordedAt}>{stamp(event.recordedAt,detail.serviceTimezone)}</time> · <strong>{label(event.action)}</strong>{event.tripLegId&&<span> · {legs.find(leg=>leg.tripLegId===event.tripLegId)?.riderLabel??'Trip leg'}</span>}
          {event.outcome&&<span> · {label(event.outcome)}</span>}{event.reason&&<span> · {label(event.reason)}</span>}
          {event.occurredAt!==event.recordedAt&&<small>Device time {stamp(event.occurredAt,detail.serviceTimezone)}</small>}
        </li>)}</ol>}
        <h4>GPS trace</h4>{clientId&&<p className="form-hint">Only fixes between this client’s recorded leg actions are shown. Other shift travel is hidden. Missing action times mean a client-bounded trace may be unavailable.</p>}
        <RouteStreetMap api={api} day={day} track={shownTrack} clientId={clientId||null} history fallback={<TracePlot track={shownTrack} history/>}/>
        <dl><dt>First saved fix</dt><dd>{stamp(trace[0]?.capturedAt??null,detail.serviceTimezone)}</dd>
          <dt>Last saved fix</dt><dd>{stamp(trace.at(-1)?.capturedAt??null,detail.serviceTimezone)}</dd>
          <dt>Fixes shown</dt><dd>{trace.length}{!clientId&&detail.trace.length===500?' (latest 500)':''}</dd></dl>
        {trace.length>0&&<details className="route-fix-log"><summary>GPS fix log ({trace.length} fix{trace.length===1?'':'es'})</summary>
          <p className="form-hint">A gap over 90 seconds is unobserved travel, not a drawn route segment.</p>
          <div className="table-scroll" tabIndex={0} role="group" aria-label="Scrollable GPS fix log"><table><thead><tr><th scope="col">Fix</th><th scope="col">Captured</th><th scope="col">Latitude</th><th scope="col">Longitude</th><th scope="col">Accuracy</th><th scope="col">Gap</th></tr></thead>
            <tbody>{trace.map((point,index)=>{const gap=gapSeconds(point,trace[index-1]);return <tr key={`${point.capturedAt}-${index}`}><th scope="row">{index+1}</th><td>{stamp(point.capturedAt,detail.serviceTimezone)}</td><td>{point.latitude.toFixed(5)}</td><td>{point.longitude.toFixed(5)}</td><td>{point.accuracyMeters===null?'Unknown':`±${Math.round(point.accuracyMeters)} m`}</td><td>{gap>90?`${gap} s unobserved`:'—'}</td></tr>;})}</tbody></table></div>
        </details>}
        <p className="form-hint">The street map follows saved GPS fixes without road snapping. The server returns at most the latest 500 fixes during raw-location retention; older positions may be unavailable.</p>
      </article>}</div>}
  </section>;
}
