import {useEffect,useRef,useState} from 'react';
import {DevelopmentApiError} from '@kavaroutes/api-contracts/private-development-transport';
import type {createCloudApi} from '../cloud-api';
import type {CloudBoard} from '../cloud-board-contract';
import type {RoadGoal,RoadPreview,RoadSelection} from '../road-route-contract';

type Leg=CloudBoard['legs'][number];
const labels:Record<RoadGoal,string>={LOW_COST:'Shortest distance / lower toll cost',FASTEST:'Fastest drive',EASIEST:'Easiest to traverse'};
const miles=(meters:number)=>(meters/1609.344).toFixed(1);
const minutes=(seconds:number)=>Math.max(1,Math.round(seconds/60));
function problem(error:unknown){
  if(error instanceof DevelopmentApiError){
    if(error.code==='MAPS_NOT_CONFIGURED'||error.status===503)return 'Road routing is not configured. Ask your administrator to check the Geoapify API key.';
    if(error.code==='MAPS_ADDRESS_UNRESOLVED')return 'A pickup or drop-off address could not be matched confidently. Check the full street address and retry.';
    if(error.code==='MAPS_ROUTE_UNAVAILABLE'||error.code==='MAPS_ROUTE_INVALID'||error.status===502)return 'Could not generate this route. Check the pickup and drop-off addresses, then retry.';
    if(error.status===412)return 'Another dispatcher changed this route. Refresh the selected route and try again.';
  }
  return 'Route suggestions are unavailable. Retry after checking the connection.';
}

export function RoadRoutePlanner({api,legs,enabled}:{api:ReturnType<typeof createCloudApi>;legs:Leg[];enabled:boolean}){
  const [legId,setLegId]=useState(legs[0]?.tripLegId??'');
  const [goal,setGoal]=useState<RoadGoal|''>('');
  const [selection,setSelection]=useState<RoadSelection|null>(null);
  const [preview,setPreview]=useState<RoadPreview|null>(null);
  const [seen,setSeen]=useState<Partial<Record<RoadGoal,RoadPreview>>>({});
  const [busy,setBusy]=useState(false),[message,setMessage]=useState('');
  const generation=useRef(0);
  const pending=useRef<{legId:string;goal:RoadGoal;expectedVersion:number;key:string}|null>(null);
  const leg=legs.find(item=>item.tripLegId===legId)??legs[0];
  useEffect(()=>{
    if(!legs.some(item=>item.tripLegId===legId))setLegId(legs[0]?.tripLegId??'');
  },[legs,legId]);
  useEffect(()=>{
    const current=++generation.current;
    setGoal('');setPreview(null);setSeen({});setSelection(null);setMessage('');pending.current=null;
    if(!enabled||!legId)return;
    void api.roadRouteSelection(legId).then(result=>{if(generation.current===current)setSelection(result.value);})
      .catch(error=>{if(generation.current===current)setMessage(problem(error));});
    return()=>{generation.current++;};
  },[api,enabled,legId]);
  const chooseGoal=async(value:RoadGoal|'')=>{
    const current=++generation.current;setGoal(value);setPreview(null);setMessage('');pending.current=null;
    if(!value||!leg)return;
    setBusy(true);
    try{const result=await api.previewRoadRoute(leg.tripLegId,value);
      if(generation.current!==current)return;
      setPreview(result.value);setSeen(previous=>({...previous,[value]:result.value}));
    }catch(error){if(generation.current===current)setMessage(problem(error));}
    finally{if(generation.current===current)setBusy(false);}
  };
  const save=async()=>{
    if(!leg||!goal||!preview||!selection||busy)return;
    const command=pending.current??{legId:leg.tripLegId,goal,expectedVersion:selection.version,key:`road-select-${crypto.randomUUID()}`};
    pending.current=command;setBusy(true);setMessage('Saving the route for the driver…');
    try{const result=await api.selectRoadRoute(command.legId,command.goal,command.expectedVersion,command.key);
      pending.current=null;setSelection(result.value);setMessage('Route choice saved. The driver will see fresh directions for this goal.');
    }catch(error){
      if(error instanceof DevelopmentApiError&&error.status>=400&&error.status<500&&error.code!=='OUTCOME_UNKNOWN')pending.current=null;
      setMessage(problem(error));
      if(error instanceof DevelopmentApiError&&error.status===412){try{setSelection((await api.roadRouteSelection(leg.tripLegId)).value);}catch{/* keep the conflict visible */}}
    }finally{setBusy(false);}
  };
  if(!legs.length)return null;
  const duplicate=preview&&Object.entries(seen).find(([other,result])=>other!==goal&&result?.pathFingerprint===preview.pathFingerprint)?.[0] as RoadGoal|undefined;
  return <section className="road-route-planner" aria-label="Road route options">
    <div className="section-heading"><div><p className="eyebrow">Road directions</p><h3>Choose a route for the driver</h3><p>Compare one trip leg at a time. Routes update when you choose an option.</p></div></div>
    <div className="road-route-controls"><label>Trip leg <select value={leg?.tripLegId??''} disabled={busy} onChange={event=>setLegId(event.target.value)}>
      {legs.map(item=><option key={item.tripLegId} value={item.tripLegId}>{item.riderLabel} · {item.pickupLabel} → {item.dropoffLabel}</option>)}
    </select></label><label>Route goal <select value={goal} disabled={!enabled||busy||!selection} onChange={event=>void chooseGoal(event.target.value as RoadGoal|'')}>
      <option value="">Choose a route goal</option>{(Object.keys(labels) as RoadGoal[]).map(value=><option key={value} value={value}>{labels[value]}</option>)}
    </select></label></div>
    {selection?.goal&&<p className="road-route-selected">Sent to driver: <strong>{labels[selection.goal]}</strong></p>}
    {busy&&<p role="status">{preview?'Saving route…':'Generating route and map…'}</p>}
    {message&&<p role={message.startsWith('Route choice saved')?'status':'alert'}>{message}</p>}
    {preview&&<div className="road-route-result">
      <div className="road-route-map">{preview.mapImageUrl?<img src={preview.mapImageUrl} alt={`${labels[preview.goal]} road map from pickup to drop-off`} />:<p>Map preview unavailable.</p>}<a href="https://www.geoapify.com/" target="_blank" rel="noreferrer">Powered by Geoapify</a></div>
      <div className="road-route-summary"><strong>{labels[preview.goal]}</strong><p>{miles(preview.distanceMeters)} mi · about {minutes(preview.durationSeconds)} min · {preview.maneuverCount} weighted maneuvers</p>
        <p>{preview.tollsExpected?'Toll road indicated; price unavailable.':'No toll road indicated in the proposed route.'}</p>
        <p>{preview.note}</p>{duplicate&&<p role="status">This follows the same roads as “{labels[duplicate]}”.</p>}
        <button className="primary" disabled={busy||selection?.goal===preview.goal} onClick={()=>void save()}>{pending.current?'Retry this route choice':selection?.goal===preview.goal?'Already sent to driver':'Choose for driver'}</button>
        <a href={preview.googleMapsUrl} target="_blank" rel="noreferrer">Inspect in Google Maps</a>
      </div>
      <details className="road-route-steps"><summary>Preview turn-by-turn directions ({preview.steps.length} steps)</summary><ol>{preview.steps.map((step,index)=><li key={index}>{step.instruction}</li>)}</ol></details>
      <p className="form-hint">Google Maps may recalculate when opened. Confirm vehicle access, pickup side, and road restrictions before driving.</p>
    </div>}
  </section>;
}
