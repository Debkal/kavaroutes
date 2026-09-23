import {useEffect,useState} from 'react';
import type {createCloudApi} from '../cloud-api';
import {CloudReturnReview} from './CloudReturnReview';
import {businessTimezone} from '../business-time';
import {shiftBandLabel} from '../shift-band';

type Api=ReturnType<typeof createCloudApi>;
type Track=Awaited<ReturnType<Api['tracking']>>['value']['shifts'][number];

const time=(value:string)=>new Date(value).toLocaleTimeString('en-US',{timeZone:businessTimezone,hour:'numeric',minute:'2-digit'});
const stamp=(value:string|null)=>value?new Date(value).toLocaleTimeString('en-US',{timeZone:businessTimezone,hour:'numeric',minute:'2-digit',second:'2-digit'}):'Nothing received';

/** The trace on a plain SVG: no tile provider and no third-party map call, which keeps
 * the location data inside this origin while still showing where the driver went. */
function TracePlot({track}:{track:Track}){
  const points=track.trace.length?track.trace:(track.position?[track.position]:[]);
  if(!points.length)return <p role="status">No position received yet for this driver.</p>;
  const lats=points.map(p=>p.latitude),lngs=points.map(p=>p.longitude);
  const minLat=Math.min(...lats),maxLat=Math.max(...lats),minLng=Math.min(...lngs),maxLng=Math.max(...lngs);
  const spanLat=Math.max(maxLat-minLat,0.0008),spanLng=Math.max(maxLng-minLng,0.0008);
  const padLat=spanLat*0.15,padLng=spanLng*0.15;
  const x=(lng:number)=>((lng-(minLng-padLng))/(spanLng+2*padLng))*100;
  const y=(lat:number)=>100-((lat-(minLat-padLat))/(spanLat+2*padLat))*100;
  const path=points.map(p=>`${x(p.longitude).toFixed(2)},${y(p.latitude).toFixed(2)}`).join(' ');
  const last=points[points.length-1]!;
  return <svg viewBox="0 0 100 100" role="img" preserveAspectRatio="none" className="driver-trace"
    aria-label={`${track.driverLabel}: trace of ${points.length} fix${points.length===1?'':'es'} from ${time(points[0]!.capturedAt)} to ${time(last.capturedAt)}, last fix within ${last.accuracyMeters===null?'unknown':Math.round(last.accuracyMeters)} metres.`}>
    <rect x="0" y="0" width="100" height="100" className="driver-trace-bg"/>
    {points.length>1&&<polyline points={path} className="driver-trace-line" fill="none"/>}
    <circle cx={x(last.longitude)} cy={y(last.latitude)} r="2.4" className="driver-trace-marker"/>
  </svg>;
}

const stateCopy=(track:Track)=>{
  if(track.lifecycle==='SHIFT_ENDED')return {label:'Shift ended',tone:'status-completed' as const};
  if(track.contactDriver)return {label:'Lost signal',tone:'status-late' as const};
  if(track.status==='UPDATES_CURRENT')return {label:'Live',tone:'status-completed' as const};
  return {label:'Starting up',tone:'status-in_progress' as const};
};

/** Active-driver list and selected shift detail in the tracking workspace. */
export function DispatchDriverTracking({api,day,enabled}:{api:Api;day:string;enabled:boolean}){
  const [tracks,setTracks]=useState<readonly Track[]|null>(null);
  const [selected,setSelected]=useState<string|null>(null);
  const [error,setError]=useState(false);
  const [busy,setBusy]=useState(false);
  const [updatedAt,setUpdatedAt]=useState<string|null>(null);
  // Poll the selected service day; a late response from yesterday must never
  // replace today's list. Manual refresh remains available between polls.
  useEffect(()=>{
    if(!enabled){setTracks(null);setUpdatedAt(null);return;}
    let current=true;
    const poll=async()=>{
      try{const result=await api.tracking(day);if(current){setTracks(result.value.shifts);setError(false);setUpdatedAt(new Date().toISOString());}}
      catch{if(current)setError(true);}
    };
    setTracks(null);setSelected(null);void poll();
    const timer=window.setInterval(()=>void poll(),10_000);
    return()=>{current=false;window.clearInterval(timer);};
  },[api,day,enabled]);
  const refresh=async()=>{setBusy(true);try{setTracks((await api.tracking(day)).value.shifts);setError(false);setUpdatedAt(new Date().toISOString());}catch{setError(true);}finally{setBusy(false);}};
  const active=(tracks??[]).filter(track=>track.lifecycle!=='SHIFT_ENDED');
  const ended=(tracks??[]).filter(track=>track.lifecycle==='SHIFT_ENDED');
  const detail=active.find(track=>track.shiftReference===selected)??active[0]??null;
  const state=detail?stateCopy(detail):null;
  return <section id="live-driver-tracking" aria-label="Live driver tracking" className="dispatch-map">
    <div className="section-heading"><div><p className="eyebrow">Live positioning</p><h2>Active drivers</h2>
      <p>Positions update about every 10 seconds while drivers keep the web app open.</p></div>
      <button disabled={busy||!enabled} onClick={()=>void refresh()}>{busy?'Refreshing…':'Refresh tracking'}</button></div>
    <p className="dispatch-summary" aria-label="Tracking summary"><span><strong>{active.length}</strong> active</span><span><strong>{active.filter(track=>track.status==='UPDATES_CURRENT').length}</strong> live</span><span><strong>{active.filter(track=>track.contactDriver).length}</strong> need contact</span>{updatedAt&&<span>Checked {stamp(updatedAt)}</span>}</p>
    {error&&<p role="alert">Driver positions unavailable. The map is not current; verify with the driver before acting.</p>}
    {tracks!==null&&active.length===0&&<p role="status">No active driver shifts for this service date. Assigned drivers appear after they start their shift.</p>}
    {active.length>0&&<div className="driver-tracking-layout"><div className="driver-tracking-list" aria-label="Active driver list">
      {active.map(track=>{const status=stateCopy(track);return <button type="button" key={track.shiftReference} className={track.shiftReference===detail?.shiftReference?'selected':''} aria-pressed={track.shiftReference===detail?.shiftReference} onClick={()=>setSelected(track.shiftReference)}>
        <strong>{track.driverLabel}</strong><span className={track.contactDriver?'status status-late':`status ${status.tone}`}>{status.label}</span>
        <small>{track.vehicleLabel??'Vehicle pending'} · {shiftBandLabel(track.plannedStartAt,businessTimezone)}</small>
        <small>Last fix {stamp(track.lastCapturedAt)}</small>
      </button>;})}</div>
      {detail&&<article key={detail.shiftReference} className={`driver-track ${detail.contactDriver?'lost':''}`}>
        <header><div><h3>{detail.driverLabel}</h3><p>{detail.vehicleLabel??'No vehicle on the assignment'} · started {time(detail.startedAt)}</p></div>
          <span className={detail.contactDriver?'status status-late':`status ${state?.tone}`}>{state?.label}</span></header>
        {detail.contactDriver?<p role="alert">No location update for {detail.silentSeconds} s. Contact the driver and ask them to enable location sharing; the app retries every {detail.retryAfterSeconds} s.</p>
          :<p role="status">{detail.position?`Last saved fix ${stamp(detail.position.capturedAt)}.`:'Waiting for the first saved location fix.'}</p>}
        <TracePlot track={detail}/>
        <dl><dt>Last fix</dt><dd>{detail.position?`${stamp(detail.position.capturedAt)} · ±${detail.position.accuracyMeters===null?'unknown':Math.round(detail.position.accuracyMeters)} m`:'No fix received'}</dd>
          <dt>Received</dt><dd>{stamp(detail.lastReceivedAt)}</dd><dt>Fixes</dt><dd>{detail.trace.length}</dd><dt>Silence</dt><dd>{detail.silentSeconds} s</dd></dl>
        {detail.position&&<a className="action-link" target="_blank" rel="noopener noreferrer" href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${detail.position.latitude},${detail.position.longitude}`)}`}>Open last position in maps</a>}
        <CloudReturnReview api={api} shift={detail.shiftReference} label={`the ${shiftBandLabel(detail.plannedStartAt,businessTimezone)} for ${detail.driverLabel}`}/>
      </article>}</div>}
    {ended.length>0&&<details className="driver-ended-shifts"><summary>{ended.length} completed shift{ended.length===1?'':'s'}</summary><ul>{ended.map(track=><li key={track.shiftReference}>{track.driverLabel} · {shiftBandLabel(track.plannedStartAt,businessTimezone)} · last fix {stamp(track.lastCapturedAt)}</li>)}</ul></details>}
  </section>;
}
