import {useQuery} from '@tanstack/react-query';
import type {createCloudDriverWebApi} from '../cloud-driver-api';
import type {RoadGoal} from '../road-route-contract';

const names:Record<RoadGoal,string>={LOW_COST:'Shortest distance / lower toll cost',FASTEST:'Fastest drive',EASIEST:'Easiest to traverse'};
export function DriverRoadDirections({api,legId,pickup,dropoff}:{api:ReturnType<typeof createCloudDriverWebApi>;legId:string;pickup:string;dropoff:string}){
  const directions=useQuery({queryKey:['driver-road-route',legId],queryFn:({signal})=>api.roadRoute(legId,signal),retry:false,staleTime:60_000,refetchInterval:300_000});
  const selected=directions.data?.value;
  const fallback=`https://www.google.com/maps/dir/?api=1&origin=${encodeURIComponent(pickup)}&destination=${encodeURIComponent(dropoff)}&travelmode=driving`;
  return <section className="driver-road-directions" aria-label="Driving directions">
    <h3>Driving directions</h3>
    {directions.isPending&&<p role="status">Checking the route selected by dispatch…</p>}
    {directions.isError&&<p role="alert">Selected directions are temporarily unavailable. Check the pickup and drop-off with dispatch before driving.</p>}
    {selected?.selection.goal&&selected.route?<>
      <p>Dispatch chose <strong>{names[selected.selection.goal]}</strong> · {(selected.route.distanceMeters/1609.344).toFixed(1)} mi · about {Math.max(1,Math.round(selected.route.durationSeconds/60))} min.</p>
      <a className="driver-secondary driver-link" target="_blank" rel="noreferrer" href={selected.route.googleMapsUrl}>Open selected route in Google Maps</a>
      <details><summary>Turn-by-turn directions ({selected.route.steps.length} steps)</summary><ol>{selected.route.steps.map((step,index)=><li key={index}>{step.instruction}</li>)}</ol></details>
      <p className="driver-fineprint">Google Maps can recalculate while navigating. Follow road signs and confirm the pickup side and vehicle access.</p>
    </>:<>
      {selected&&<p>Dispatch has not chosen a road route for this leg.</p>}
      <a className="driver-secondary driver-link" target="_blank" rel="noreferrer" href={fallback}>Open pickup to drop-off in Google Maps</a>
    </>}
  </section>;
}
