import type {DriverLeg} from '../cloud-driver-api';

// Run status belongs to the assignment, never to an individual pickup/drop-off.
export const driverLegLifecycle=(leg:DriverLeg)=>leg.execution?.lifecycle??'AWAITING_DISPATCH';
export const completedDriverLegs=(legs:readonly DriverLeg[])=>legs.filter(leg=>driverLegLifecycle(leg)==='COMPLETED');

export function DriverCompletedTrips({legs}:{legs:readonly DriverLeg[]}){
  const completed=completedDriverLegs(legs);
  if(!completed.length)return null;
  return <details className="driver-card" aria-label="Completed trips">
    <summary>Completed trips ({completed.length})</summary>
    <ul>{completed.map(leg=><li key={leg.tripLegId}>
      <strong>{leg.riderLabel}</strong> · {leg.pickupLabel} → {leg.dropoffLabel} · Completed
    </li>)}</ul>
  </details>;
}
