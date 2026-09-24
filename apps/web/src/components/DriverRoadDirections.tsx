import {useQuery} from '@tanstack/react-query';
import type {createCloudDriverWebApi} from '../cloud-driver-api';
import type {RoadGoal} from '../road-route-contract';
import {conciseRoadDirections} from '../road-route-directions';

const names:Record<RoadGoal,string>={LOW_COST:'Shortest distance / lower toll cost',FASTEST:'Fastest drive',EASIEST:'Easiest to traverse'};
export function DriverRoadDirections({api,legId,pickup,dropoff}:{api:ReturnType<typeof createCloudDriverWebApi>;legId:string;pickup:string;dropoff:string}){
  const directions=useQuery({queryKey:['driver-road-route',legId],queryFn:({signal})=>api.roadRoute(legId,signal),retry:false,staleTime:Infinity,refetchOnWindowFocus:false,refetchOnReconnect:false});
  const selected=directions.data?.value;
  const steps=selected?.route?conciseRoadDirections(selected.route.steps):[];
  const pickupLink=`https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(pickup)}&travelmode=driving&dir_action=navigate`;
  const fallback=`https://www.google.com/maps/dir/?api=1&origin=${encodeURIComponent(pickup)}&destination=${encodeURIComponent(dropoff)}&travelmode=driving`;
  const selectedLink=selected?.route?`${selected.route.googleMapsUrl}&dir_action=navigate`:null;
  return <section className="driver-road-directions" aria-label="Driving directions">
    <h3>Driving directions</h3>
    {directions.isPending&&<p role="status">Checking the route selected by dispatch…</p>}
    {directions.isError&&<p role="alert">Selected directions are temporarily unavailable. Check the pickup and drop-off with dispatch before driving.</p>}
    {selected?.selection.goal&&selected.route?<>
      <p>Dispatch chose <strong>{names[selected.selection.goal]}</strong> · {(selected.route.distanceMeters/1609.344).toFixed(1)} mi · about {Math.max(1,Math.round(selected.route.durationSeconds/60))} min.</p>
      <a className="driver-secondary driver-link" target="_blank" rel="noreferrer" href={pickupLink}>Navigate to pickup from my location</a>
      <a className="driver-primary driver-link" target="_blank" rel="noreferrer" href={selectedLink??undefined}>Navigate pickup to drop-off in Google Maps</a>
      <details><summary>Route directions ({steps.length} steps)</summary><ol>{steps.map((step,index)=><li key={index}>{step}</li>)}</ol></details>
      <button className="driver-secondary" type="button" disabled={directions.isFetching} onClick={()=>void directions.refetch()}>{directions.isFetching?'Refreshing route…':'Refresh if Dispatch changes the route'}</button>
      <p className="driver-fineprint">Google Maps gives live navigation and may recalculate the road path. Follow road signs and confirm pickup access.</p>
    </>:<>
      {selected&&<p role="alert">Dispatch has not chosen a road route for this leg. Confirm the drive with Dispatch before setting out; the link below is a basic map and may use a different path.</p>}
      <a className="driver-secondary driver-link" target="_blank" rel="noreferrer" href={pickupLink}>Navigate to pickup from my location</a>
      <a className="driver-secondary driver-link" target="_blank" rel="noreferrer" href={fallback}>Open pickup to drop-off in Google Maps</a>
    </>}
  </section>;
}
