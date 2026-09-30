import {useMemo,useState} from 'react';
import {Link} from 'react-router';
import {useQuery} from '@tanstack/react-query';
import type {createCloudApi} from '../cloud-api';
import {dispatchQueries} from '../dispatch-queries';
import {indexRouteHistory} from '../route-history-index';
import {TracePlot} from './DispatchDriverTracking';
import {RouteStreetMap,legColor} from './RouteStreetMap';
import {shiftBandLabel} from '../shift-band';
import {downloadCsv} from '../csv';
import {routeHistoryRows} from '../route-history-csv';
import {downloadTraceKml,traceKml} from '../route-trace-export';

type Api=ReturnType<typeof createCloudApi>;
type Track=Awaited<ReturnType<Api['tracking']>>['value']['shifts'][number];
const stamp=(value:string|null,zone:string)=>value?new Date(value).toLocaleString('en-US',{timeZone:zone,month:'short',day:'numeric',hour:'numeric',minute:'2-digit',second:'2-digit',timeZoneName:'short'}):'Not recorded';
const label=(value:string)=>value.replaceAll('_',' ').toLowerCase().replace(/\b\w/g,letter=>letter.toUpperCase());
const gapSeconds=(current:Track['trace'][number],previous:Track['trace'][number]|undefined)=>previous?Math.max(0,Math.round((Date.parse(current.capturedAt)-Date.parse(previous.capturedAt))/1000)):0;

export function DispatchRouteHistory({api,day,enabled}:{api:Api;day:string;enabled:boolean}){
  const [selected,setSelected]=useState<string|null>(null),[driverId,setDriverId]=useState(''),[clientId,setClientId]=useState('');
  const [legWindow,setLegWindow]=useState<number|null>(null);
  const tracks=useQuery({...dispatchQueries.tracking(api,day),enabled});
  const board=useQuery({...dispatchQueries.board(api,day),enabled});
  const history=useQuery({...dispatchQueries.history(api,day),enabled});
  const allCompleted=useMemo(()=>(tracks.data?.value.shifts??[]).filter(track=>track.lifecycle==='SHIFT_ENDED'),[tracks.data]);
  const historyIndex=useMemo(()=>indexRouteHistory(history.data?.value.events??[],board.data?.value.legs??[]),[history.data,board.data]);
  const runOf=(shift:string)=>historyIndex.runByShift.get(shift)??null;
  const clientForTrip=useMemo(()=>new Map((history.data?.value.tripClients??[]).map(item=>[item.tripId,item])),[history.data]);
  const clients=new Map<string,string>();
  for(const track of allCompleted){const runId=runOf(track.shiftReference);
    for(const leg of historyIndex.legsByRun.get(runId??'')??[]){const client=clientForTrip.get(leg.tripId);if(client)clients.set(client.clientId,client.clientLabel);}}
  const completed=allCompleted.filter(track=>{
    if(driverId&&track.driverId!==driverId)return false;
    if(!clientId)return true;
    const runId=runOf(track.shiftReference);
    return (historyIndex.legsByRun.get(runId??'')??[]).some(leg=>clientForTrip.get(leg.tripId)?.clientId===clientId);
  });
  const detail=completed.find(track=>track.shiftReference===selected)??completed[0]??null;
  const fullTrace=useQuery({...dispatchQueries.trace(api,day,detail?.shiftReference??null,clientId||null),enabled:enabled&&!!detail});
  const runId=detail?runOf(detail.shiftReference):null;
  const legs=(historyIndex.legsByRun.get(runId??'')??[]).filter(leg=>!clientId||clientForTrip.get(leg.tripId)?.clientId===clientId);
  const selectedLeg=legs.find(leg=>leg.ordinal===legWindow)??null;
  const activeWindow=selectedLeg?legWindow:null;
  const legIds=new Set(legs.map(leg=>leg.tripLegId));
  const detailEvents=(historyIndex.eventsByShift.get(detail?.shiftReference??'')??[]).filter(event=>!clientId||event.tripLegId===null||legIds.has(event.tripLegId));
  const shownEvents=selectedLeg?detailEvents.filter(event=>event.tripLegId===selectedLeg.tripLegId):detailEvents;
  const orderedLegs=[...legs].sort((a,b)=>a.ordinal-b.ordinal);
  const betweenLegs=orderedLegs.slice(1).flatMap((next,index)=>{
    const previous=orderedLegs[index]!;
    const completed=historyIndex.applied(detail?.shiftReference??'',previous.tripLegId,'COMPLETE_LEG');
    const departed=historyIndex.applied(detail?.shiftReference??'',next.tripLegId,'MARK_EN_ROUTE');
    if(!completed||!departed)return [];
    const minutes=Math.round((Date.parse(departed.occurredAt)-Date.parse(completed.occurredAt))/60_000);
    return minutes>0?[{from:previous.ordinal,to:next.ordinal,minutes}]:[];
  });
  const intervals=clientId?legs.flatMap(leg=>{
    const start=['MARK_EN_ROUTE','ARRIVE_PICKUP','BOARD_RIDER'].map(action=>historyIndex.applied(detail?.shiftReference??'',leg.tripLegId,action)).find(Boolean);
    const end=historyIndex.applied(detail?.shiftReference??'',leg.tripLegId,'COMPLETE_LEG')??historyIndex.applied(detail?.shiftReference??'',leg.tripLegId,'MARK_RIDER_NO_SHOW');
    return start?[[Date.parse(start.occurredAt),Date.parse(end?.occurredAt??detail?.lastCapturedAt??start.occurredAt)] as const]:[];
  }):[];
  const trace=fullTrace.data?.value.points??[];
  const visibleTrace=useMemo(()=>activeWindow===null?trace:trace.filter(point=>point.window===activeWindow),[trace,activeWindow]);
  const recentTrace=detail?(clientId?detail.trace.filter(point=>intervals.some(([start,end])=>Date.parse(point.capturedAt)>=start&&Date.parse(point.capturedAt)<=end)):detail.trace):[];
  const shownTrace=fullTrace.data?visibleTrace:recentTrace;
  const shownTrack=detail?{...detail,trace:shownTrace,position:shownTrace.at(-1)??null}:null;
  const loading=tracks.isPending||board.isPending||history.isPending;
  const failed=tracks.isError||board.isError||history.isError;
  const refresh=()=>{void Promise.all([tracks.refetch(),board.refetch(),history.refetch(),...(detail?[fullTrace.refetch()]:[])]);};
  const exportSelected=()=>{if(!detail||!board.data||!history.data)return;
    downloadCsv(`kavaroutes-route-history-${day}-${detail.shiftReference.slice(0,8)}${selectedLeg?`-leg-${selectedLeg.ordinal}`:''}.csv`,routeHistoryRows({day,track:detail,board:board.data.value,history:history.data.value,trace:visibleTrace,legIds:selectedLeg?[selectedLeg.tripLegId]:legs.map(leg=>leg.tripLegId)}));};
  const exportMap=()=>{if(!detail||!visibleTrace.length)return;
    downloadTraceKml(`kavaroutes-gps-${day}-${detail.shiftReference.slice(0,8)}${selectedLeg?`-leg-${selectedLeg.ordinal}`:''}.kml`,traceKml(day,visibleTrace));};
  return <section id="route-history" className="workspace-card route-history" aria-label="Completed route history">
    <div className="section-heading"><div><p className="eyebrow">Dispatch records</p><h2>Route history</h2>
      <p>Review completed shifts, each trip leg, recorded pickup and drop-off actions, and the GPS trace. Times use the route’s service timezone.</p></div>
      <button type="button" disabled={!enabled||tracks.isFetching||board.isFetching||history.isFetching} onClick={refresh}>Refresh history</button></div>
    {loading&&enabled&&<p role="status">Loading route history for {day}…</p>}
    {failed&&<p role="alert">Some route history data could not load. Retry before relying on this report or exporting it.</p>}
    {fullTrace.isError&&detail&&<p role="alert">The selected shift’s full GPS trace could not load; GPS exports are unavailable.</p>}
    {fullTrace.data?.value.truncated&&<p role="alert">The selected shift exceeds 100,000 GPS fixes. Its displayed trace and GPS exports are incomplete.</p>}
    {history.data?.value.truncated&&<p role="alert">This service day has more than 3,000 recorded events. The event list and CSV are incomplete.</p>}
    <div className="route-history-filters"><label>Driver <select aria-label="Filter route history by driver" value={driverId} onChange={event=>{setDriverId(event.target.value);setSelected(null);setLegWindow(null);}}>
      <option value="">All drivers</option>{[...new Map(allCompleted.map(track=>[track.driverId,track.driverLabel])).entries()].sort((a,b)=>a[1].localeCompare(b[1])).map(([id,name])=><option key={id} value={id}>{name}</option>)}
    </select></label><label>Client <select aria-label="Filter route history by client" value={clientId} disabled={!history.data||!board.data} onChange={event=>{setClientId(event.target.value);setSelected(null);setLegWindow(null);}}>
      <option value="">All clients</option>{[...clients.entries()].sort((a,b)=>a[1].localeCompare(b[1])).map(([id,name])=><option key={id} value={id}>{name}</option>)}
    </select></label></div>
    {!loading&&!failed&&completed.length===0&&<p role="status">No completed shifts match these filters on {day}. An ongoing shift appears in <Link to="/tracking">Active drivers</Link>.</p>}
    {completed.length>0&&<div className="driver-tracking-layout"><div className="driver-tracking-list" aria-label="Completed shift list">
      {completed.map(track=><button type="button" key={track.shiftReference} className={detail?.shiftReference===track.shiftReference?'selected':''}
        aria-pressed={detail?.shiftReference===track.shiftReference} onClick={()=>{setSelected(track.shiftReference);setLegWindow(null);}}>
        <strong>{track.driverLabel}</strong><span className="status status-completed">Completed</span>
        <small>{track.vehicleLabel??'Vehicle unavailable'} · {shiftBandLabel(track.plannedStartAt,track.serviceTimezone)}</small>
        <small>{track.shiftReference===detail?.shiftReference&&fullTrace.data?fullTrace.data.value.fixCount.toLocaleString():`${track.trace.length}${track.trace.length===500?'+':''}`} saved fix{track.trace.length===1?'':'es'} · last {stamp(track.lastCapturedAt,track.serviceTimezone)}</small>
      </button>)}</div>
      {detail&&shownTrack&&<article key={detail.shiftReference} className="driver-track route-history-detail">
        <header><div><h3>{detail.driverLabel} · {shiftBandLabel(detail.plannedStartAt,detail.serviceTimezone)}</h3>
          <p>{detail.vehicleLabel??'Vehicle unavailable'} · started {stamp(detail.startedAt,detail.serviceTimezone)} · {detail.serviceTimezone}</p></div>
          <span className="status status-completed">Completed</span></header>
        <div className="route-history-exports"><button type="button" disabled={!board.data||!history.data||failed||fullTrace.isPending||fullTrace.isError} onClick={exportSelected}>Export selected history CSV</button>
          <button type="button" disabled={!fullTrace.data||!visibleTrace.length} onClick={exportMap}>Export GPS for Google My Maps (KML)</button></div>
        <p className="form-hint">Run {runId??'unavailable'} · {legs.length} trip leg{legs.length===1?'':'s'} shown · {detailEvents.length} recorded event{detailEvents.length===1?'':'s'}.</p>
        <h4>Trip legs</h4>{legs.length===0?<p role="status">No trip legs are linked to this recorded shift.</p>:<ol className="route-history-legs">{legs.map(leg=><li key={leg.tripLegId}>
          <span className="route-leg-swatch" style={{backgroundColor:legColor(leg.ordinal)}} aria-hidden="true"/>
          <strong>{leg.riderLabel}</strong><span>{clientForTrip.get(leg.tripId)?.clientLabel??'No client account linked'} · {leg.pickupLabel} → {leg.dropoffLabel}</span>
          <span>Planned {stamp(leg.plannedStartAt,detail.serviceTimezone)} to {stamp(leg.plannedEndAt,detail.serviceTimezone)} · {label(leg.lifecycle)}</span>
          <span>Pickup arrival: {stamp(historyIndex.applied(detail?.shiftReference??'',leg.tripLegId,'ARRIVE_PICKUP')?.recordedAt??null,detail.serviceTimezone)} · Boarded: {stamp(historyIndex.applied(detail?.shiftReference??'',leg.tripLegId,'BOARD_RIDER')?.recordedAt??null,detail.serviceTimezone)}</span>
          <span>Drop-off arrival: {stamp(historyIndex.applied(detail?.shiftReference??'',leg.tripLegId,'ARRIVE_DROPOFF')?.recordedAt??null,detail.serviceTimezone)} · Completed: {stamp(historyIndex.applied(detail?.shiftReference??'',leg.tripLegId,'COMPLETE_LEG')?.recordedAt??null,detail.serviceTimezone)}</span>
        </li>)}</ol>}
        {betweenLegs.length>0&&<p className="form-hint">{betweenLegs.map(item=>`Between leg ${item.from} and ${item.to}: ${item.minutes} min from completion to next departure`).join(' · ')}. This interval includes waiting time; GPS reporting gaps within it are left open.</p>}
        <h4>Recorded route events</h4>{shownEvents.length===0?<p>No driver actions are recorded for this selection.</p>:<ol className="route-event-list" aria-label="Recorded route events">{shownEvents.map((event,index)=><li key={`${event.shiftReference}-${index}`}>
          <time dateTime={event.recordedAt}>{stamp(event.recordedAt,detail.serviceTimezone)}</time> · <strong>{label(event.action)}</strong>{event.tripLegId&&<span> · {historyIndex.legById.get(event.tripLegId)?.riderLabel??'Trip leg'}</span>}
          {event.outcome&&<span> · {label(event.outcome)}</span>}{event.reason&&<span> · {label(event.reason)}</span>}
          {event.occurredAt!==event.recordedAt&&<small>Device time {stamp(event.occurredAt,detail.serviceTimezone)}</small>}
        </li>)}</ol>}
        <h4>GPS trace</h4>{clientId&&<p className="form-hint">Only fixes between this client’s recorded leg actions are shown. Other shift travel is hidden. Missing action times mean a client-bounded trace may be unavailable.</p>}
        {legs.length>1&&<label className="route-leg-filter">Map leg <select aria-label="Filter route map by leg" value={activeWindow??''} onChange={event=>setLegWindow(event.target.value===''?null:Number(event.target.value))}>
          <option value="">All legs and shift travel</option>{legs.map(leg=><option key={leg.tripLegId} value={leg.ordinal}>Leg {leg.ordinal}: {leg.riderLabel} · {leg.pickupLabel} → {leg.dropoffLabel}</option>)}
        </select></label>}
        {selectedLeg&&visibleTrace.length===0&&fullTrace.data&&<p role="status">No saved GPS fixes fall within this leg’s recorded action times.</p>}
        <RouteStreetMap api={api} day={day} track={shownTrack} clientId={clientId||null} history selectedWindow={activeWindow}
          legLabels={legs.map(leg=>({window:leg.ordinal,label:`Leg ${leg.ordinal}: ${leg.riderLabel}`}))} fallback={<TracePlot track={shownTrack} history/>}/>
        {trace.length>0&&<p className="form-hint">For the exact recorded path, import the {selectedLeg?'selected leg’s':'shift’s'} KML file into <a href="https://www.google.com/maps/d/" target="_blank" rel="noopener noreferrer">Google My Maps</a>. The Google Maps directions link uses sampled points and may choose different roads.</p>}
        <dl><dt>First saved fix</dt><dd>{stamp(visibleTrace[0]?.capturedAt??null,detail.serviceTimezone)}</dd>
          <dt>Last saved fix</dt><dd>{stamp(visibleTrace.at(-1)?.capturedAt??null,detail.serviceTimezone)}</dd>
          <dt>Fixes shown</dt><dd>{visibleTrace.length}{fullTrace.isPending?' (loading full trace)':''}</dd></dl>
        {visibleTrace.length>0&&<details className="route-fix-log"><summary>GPS fix log ({visibleTrace.length} fix{visibleTrace.length===1?'':'es'})</summary>
          <p className="form-hint">A gap over 90 seconds has no recorded GPS fixes; when it falls between trip legs, it may reflect waiting time.</p>
          <div className="table-scroll" tabIndex={0} role="group" aria-label="Scrollable GPS fix log"><table><thead><tr><th scope="col">Fix</th><th scope="col">Captured</th><th scope="col">Latitude</th><th scope="col">Longitude</th><th scope="col">Accuracy</th><th scope="col">Gap</th></tr></thead>
            <tbody>{visibleTrace.slice(0,1000).map((point,index)=>{const gap=gapSeconds(point,visibleTrace[index-1]);return <tr key={`${point.capturedAt}-${index}`}><th scope="row">{index+1}</th><td>{stamp(point.capturedAt,detail.serviceTimezone)}</td><td>{point.latitude.toFixed(5)}</td><td>{point.longitude.toFixed(5)}</td><td>{point.accuracyMeters===null?'Unknown':`±${Math.round(point.accuracyMeters)} m`}</td><td>{gap>90?`${gap} s without fixes`:'—'}</td></tr>;})}</tbody></table></div>
          {visibleTrace.length>1000&&<p className="form-hint">Showing the first 1,000 fixes in this table. The map and exports include all {visibleTrace.length.toLocaleString()} loaded fixes.</p>}
        </details>}
        <p className="form-hint">The map loads every retained GPS fix for the selected shift and can align observed movement to roads. Leg colors follow recorded action times; travel outside a leg is gray. Reporting gaps stay open; older raw locations may still be subject to retention.</p>
      </article>}</div>}
  </section>;
}
