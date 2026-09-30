import {useEffect,useState} from 'react';
import {useQuery} from '@tanstack/react-query';
import type {createCloudApi} from '../cloud-api';
import {dispatchQueries} from '../dispatch-queries';
import {CloudReturnReview} from './CloudReturnReview';
import {shiftBandLabel} from '../shift-band';
import {RouteStreetMap} from './RouteStreetMap';

type Api=ReturnType<typeof createCloudApi>;
type Track=Awaited<ReturnType<Api['tracking']>>['value']['shifts'][number];

const time=(value:string,zone:string)=>new Date(value).toLocaleTimeString('en-US',{timeZone:zone,hour:'numeric',minute:'2-digit',timeZoneName:'short'});
const stamp=(value:string|null,zone:string)=>value?new Date(value).toLocaleTimeString('en-US',{timeZone:zone,hour:'numeric',minute:'2-digit',second:'2-digit',timeZoneName:'short'}):'Nothing received';
const auditLabel=(action:string)=>action==='UPDATES_CURRENT'?'GPS updates restored':action==='UPDATES_OVERDUE'||action==='NO_UPDATES'?'GPS updates interrupted':action==='TRACKING_STOPPED'?'Location sharing stopped':action.replaceAll('_',' ').toLowerCase();

const GAP_AFTER_MS=90_000;
/** Keep the driver's fixes on this origin. A broken feed must never be rendered as a
 * straight, observed road segment, and the plot must not distort the route shape. */
export function TracePlot({track,history=false}:{track:Track;history?:boolean}){
  const points=track.trace.length?track.trace:(track.position?[track.position]:[]);
  if(!points.length)return <p role="status">No position received yet for this driver.</p>;
  const width=600,height=240,padding=28;
  const projected=points.map(point=>({x:point.longitude*Math.PI/180,
    y:Math.log(Math.tan(Math.PI/4+Math.max(-85,Math.min(85,point.latitude))*Math.PI/360))}));
  const xs=projected.map(point=>point.x),ys=projected.map(point=>point.y);
  const left=Math.min(...xs),right=Math.max(...xs),bottom=Math.min(...ys),top=Math.max(...ys);
  const scale=Math.max((right-left)/(width-2*padding),(top-bottom)/(height-2*padding),0.0000003);
  const centerX=(left+right)/2,centerY=(bottom+top)/2;
  const plot=(index:number)=>({x:width/2+(projected[index]!.x-centerX)/scale,
    y:height/2-(projected[index]!.y-centerY)/scale});
  const segments:number[][]=[];
  let gaps=0;
  points.forEach((point,index)=>{
    const previous=points[index-1];
    if(!previous||Date.parse(point.capturedAt)-Date.parse(previous.capturedAt)>GAP_AFTER_MS){
      if(previous)gaps++;
      segments.push([]);
    }
    segments[segments.length-1]!.push(index);
  });
  const start=plot(0),end=plot(points.length-1);
  const last=points[points.length-1]!;
  return <figure className="driver-trace-figure"><svg viewBox={`0 0 ${width} ${height}`} role="img" preserveAspectRatio="xMidYMid meet" className="driver-trace"
    aria-label={`${track.driverLabel}: trace of ${points.length} fix${points.length===1?'':'es'} from ${time(points[0]!.capturedAt,track.serviceTimezone)} to ${time(last.capturedAt,track.serviceTimezone)}; ${gaps} tracking gap${gaps===1?'':'s'}; last fix within ${last.accuracyMeters===null?'unknown':Math.round(last.accuracyMeters)} metres.`}>
    <rect x="0" y="0" width={width} height={height} className="driver-trace-bg"/>
    <path d="M150 0V240 M300 0V240 M450 0V240 M0 60H600 M0 120H600 M0 180H600" className="driver-trace-grid"/>
    <text x="570" y="24" className="driver-trace-north">N ↑</text>
    {segments.map((segment,index)=>segment.length>1?<polyline key={index} points={segment.map(i=>{const p=plot(i);return `${p.x.toFixed(1)},${p.y.toFixed(1)}`;}).join(' ')} className="driver-trace-line" fill="none"/>:null)}
    <circle cx={start.x} cy={start.y} r="5" className="driver-trace-start"><title>First visible fix</title></circle>
    <circle cx={end.x} cy={end.y} r="7" className="driver-trace-marker"><title>Latest saved fix</title></circle>
  </svg><figcaption>{history?'Recorded GPS path':'Recent GPS path'} · {points.length} saved fix{points.length===1?'':'es'}{gaps?` · ${gaps} unobserved gap${gaps===1?'':'s'}`:''}. This geographic plot has no street background. Lines follow reported coordinates and are not snapped to roads.</figcaption></figure>;
}

const stateCopy=(track:Track)=>{
  if(track.lifecycle==='SHIFT_ENDED')return {label:'Shift ended',tone:'status-completed' as const};
  if(track.contactDriver)return {label:'Lost signal',tone:'status-late' as const};
  if(track.status==='UPDATES_CURRENT')return {label:'Live',tone:'status-completed' as const};
  return {label:'Starting up',tone:'status-in_progress' as const};
};

/** Active-driver list and selected shift detail in the tracking workspace. */
export function DispatchDriverTracking({api,day,enabled}:{api:Api;day:string;enabled:boolean}){
  const [selected,setSelected]=useState<string|null>(null);
  const tracking=useQuery({...dispatchQueries.tracking(api,day),enabled,refetchInterval:10_000});
  const tracks=enabled?tracking.data?.value.shifts??null:null;
  const error=tracking.isError,busy=tracking.isFetching;
  const updatedAt=tracking.dataUpdatedAt?new Date(tracking.dataUpdatedAt).toISOString():null;
  const refresh=()=>tracking.refetch();
  useEffect(()=>setSelected(null),[day]);
  const active=(tracks??[]).filter(track=>track.lifecycle!=='SHIFT_ENDED');
  const ended=(tracks??[]).filter(track=>track.lifecycle==='SHIFT_ENDED');
  const audit=useQuery({...dispatchQueries.history(api,day),enabled:enabled&&active.length>0,refetchInterval:60_000});
  const detail=active.find(track=>track.shiftReference===selected)??active[0]??null;
  const trackingTransitions=(audit.data?.value.events??[]).filter(event=>event.shiftReference===detail?.shiftReference&&event.kind==='TRACKING_ALERT');
  const auditEvents=trackingTransitions.filter((event,index)=>['NO_UPDATES','UPDATES_OVERDUE','TRACKING_STOPPED'].includes(event.action)||
    (event.action==='UPDATES_CURRENT'&&trackingTransitions[index-1]?.outcome==='CONTACT_DRIVER')).slice(-12).reverse();
  const state=detail?stateCopy(detail):null;
  return <section id="live-driver-tracking" aria-label="Live driver tracking" className="dispatch-map">
    <div className="section-heading"><div><p className="eyebrow">Live positioning</p><h2>Active drivers</h2>
      <p>This page checks every 10 seconds. Native Driver phones send background GPS updates during an active shift, including while Maps is open.</p></div>
      <button disabled={busy||!enabled} onClick={()=>void refresh()}>{busy?'Refreshing…':'Refresh tracking'}</button></div>
    <p className="dispatch-summary" aria-label="Tracking summary"><span><strong>{active.length}</strong> active</span><span><strong>{active.filter(track=>track.status==='UPDATES_CURRENT').length}</strong> live</span><span><strong>{active.filter(track=>track.contactDriver).length}</strong> need contact</span>{updatedAt&&<span>Checked {stamp(updatedAt,'UTC')}</span>}</p>
    {error&&<p role="alert">Driver positions unavailable. The map is not current; verify with the driver before acting.</p>}
    {tracks!==null&&active.length===0&&<p role="status">No active driver shifts for this service date. Assigned drivers appear after they start their shift.</p>}
    {active.length>0&&<div className="driver-tracking-layout"><div className="driver-tracking-list" aria-label="Active driver list">
      {active.map(track=>{const status=stateCopy(track);return <button type="button" key={track.shiftReference} className={track.shiftReference===detail?.shiftReference?'selected':''} aria-pressed={track.shiftReference===detail?.shiftReference} onClick={()=>setSelected(track.shiftReference)}>
        <strong>{track.driverLabel}</strong><span className={track.contactDriver?'status status-late':`status ${status.tone}`}>{status.label}</span>
        <small>{track.vehicleLabel??'Vehicle pending'} · {shiftBandLabel(track.plannedStartAt,track.serviceTimezone)}</small>
        <small>Last fix {stamp(track.lastCapturedAt,track.serviceTimezone)}</small>
      </button>;})}</div>
      {detail&&<article key={detail.shiftReference} className={`driver-track ${detail.contactDriver?'lost':''}`}>
        <header><div><h3>{detail.driverLabel}</h3><p>{detail.vehicleLabel??'No vehicle on the assignment'} · started {time(detail.startedAt,detail.serviceTimezone)} · {detail.serviceTimezone}</p></div>
          <span className={detail.contactDriver?'status status-late':`status ${state?.tone}`}>{state?.label}</span></header>
        {detail.contactDriver?<p role="alert">No fresh GPS fix for {detail.silentSeconds} s. The cause is unknown; check the driver's status and connection. The app retries every {detail.retryAfterSeconds} s.</p>
          :<p role="status">{detail.position?`Last saved fix ${stamp(detail.position.capturedAt,detail.serviceTimezone)}.`:'Waiting for the first saved location fix.'}</p>}
        <RouteStreetMap api={api} day={day} track={detail} fallback={<TracePlot track={detail}/>}/>
        <section className="driver-tracking-audit" aria-label="Tracking interruption audit">
          <h4>Tracking interruption audit</h4><p className="form-hint">Opening Google Maps is normal and creates no event. The server records only missing GPS updates and recovery for this shift; a missing fix cannot by itself reveal whether permission, signal, or the phone caused it.</p>
          {audit.isError&&<p role="alert">Tracking audit is temporarily unavailable. Retry or review Route History.</p>}
          {!audit.isError&&audit.isPending&&<p role="status">Loading tracking events…</p>}
          {!audit.isError&&!audit.isPending&&auditEvents.length===0&&<p role="status">No tracking interruptions recorded for this shift.</p>}
          {auditEvents.length>0&&<ol aria-label="Recorded tracking transitions">{auditEvents.map((event,index)=><li key={`${event.recordedAt}-${event.action}-${index}`}>
            <time dateTime={event.recordedAt}>{stamp(event.recordedAt,detail.serviceTimezone)}</time> · <strong>{auditLabel(event.action)}</strong>{event.outcome==='CONTACT_DRIVER'?' · Contact driver':''}
          </li>)}</ol>}
          {audit.data?.value.truncated&&<p role="alert">This service day has more events than the audit view can show. Review Route History for the available record.</p>}
        </section>
        <dl><dt>Last fix</dt><dd>{detail.position?`${stamp(detail.position.capturedAt,detail.serviceTimezone)} · ±${detail.position.accuracyMeters===null?'unknown':Math.round(detail.position.accuracyMeters)} m`:'No fix received'}</dd>
          <dt>Received</dt><dd>{stamp(detail.lastReceivedAt,detail.serviceTimezone)}</dd><dt>Fixes</dt><dd>{detail.trace.length}</dd><dt>Silence</dt><dd>{detail.silentSeconds} s</dd></dl>
        {detail.position&&<a className="action-link" target="_blank" rel="noopener noreferrer" href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${detail.position.latitude},${detail.position.longitude}`)}`}>Open last position in maps</a>}
        <CloudReturnReview api={api} shift={detail.shiftReference} label={`the ${shiftBandLabel(detail.plannedStartAt,detail.serviceTimezone)} for ${detail.driverLabel}`}/>
      </article>}</div>}
    {ended.length>0&&<p className="driver-ended-shifts">{ended.length} completed shift{ended.length===1?'':'s'} · <a href={`/route-history?date=${encodeURIComponent(day)}`}>Review route history and GPS trace</a></p>}
  </section>;
}
