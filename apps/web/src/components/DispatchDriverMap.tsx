import {useEffect,useState} from 'react';
import type {createCloudApi} from '../cloud-api';
import {CloudReturnReview} from './CloudReturnReview';
import {businessTimezone} from '../business-time';

type Api=ReturnType<typeof createCloudApi>;
type Track=Awaited<ReturnType<Api['tracking']>>['value']['shifts'][number];

const time=(value:string)=>new Date(value).toLocaleTimeString('en-US',{timeZone:businessTimezone,hour:'numeric',minute:'2-digit',second:'2-digit'});
const short=(value:string)=>value.slice(0,8);

/** The trace on a plain SVG: no tile provider and no third-party map call, which keeps
 * the location data inside this origin while still showing where the driver went. */
function TracePlot({track}:{track:Track}){
  const points=track.trace.length?track.trace:(track.position?[track.position]:[]);
  if(!points.length)return <p role="status">No position received yet for this shift.</p>;
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

export function DispatchDriverMap({api,day,enabled}:{api:Api;day:string;enabled:boolean}){
  const [tracks,setTracks]=useState<readonly Track[]|null>(null);
  const [error,setError]=useState(false);
  const [busy,setBusy]=useState(false);
  const load=async()=>{setBusy(true);try{setTracks((await api.tracking(day)).value.shifts);setError(false);}catch{setError(true);}finally{setBusy(false);}};
  // The map belongs to the service day the board is showing, so changing the day must
  // reload it rather than leave yesterday's trace on screen.
  useEffect(()=>{ if(enabled) void load(); },[day,enabled]);
  return <section aria-label="Driver map" className="dispatch-map">
    <div className="section-heading"><div><p className="eyebrow">Live positioning</p><h2>Driver map</h2>
      <p>Positions the driver's device shared while the shift was open. A gap is a gap in updates, not a proven cause.</p></div>
      <button disabled={busy||!enabled} onClick={()=>void load()}>{busy?'Refreshing…':'Refresh map'}</button></div>
    {error&&<p role="alert">Driver positions unavailable. The map is not current; verify with the driver before acting.</p>}
    {tracks!==null&&tracks.length===0&&<p role="status">No shifts are open or recorded for this service date.</p>}
    {(tracks??[]).map(track=>{
      const lost=track.contactDriver;
      return <article key={track.shiftReference} className={`driver-track ${lost?'lost':''}`}>
        <header><div><h3>{track.driverLabel} · shift {short(track.shiftReference)}</h3>
          <p>State {track.lifecycle.toLowerCase()} · {track.reason.replaceAll('_',' ').toLowerCase()}</p></div>
          <span className={lost?'status status-late':'status status-completed'}>{lost?'Lost signal':'Updates current'}</span></header>
        {lost&&<p role="alert">No location update for {track.silentSeconds} s. Contact the driver and ask them to enable location sharing; the app retries every {track.retryAfterSeconds} s.</p>}
        {!lost&&<p role="status">{track.silentSeconds===0?'Receiving location updates.':`Last update ${track.silentSeconds} s ago; alerts begin after ${track.staleAfterSeconds} s.`}</p>}
        <TracePlot track={track}/>
        <dl><dt>Last fix</dt><dd>{track.position?`${time(track.position.capturedAt)} · ±${track.position.accuracyMeters===null?'unknown':Math.round(track.position.accuracyMeters)} m`:'None received'}</dd>
          <dt>Fixes kept</dt><dd>{track.trace.length}</dd>
          <dt>Silence</dt><dd>{track.silentSeconds} s</dd></dl>
        <CloudReturnReview api={api} shift={track.shiftReference}/>
      </article>;
    })}
  </section>;
}
