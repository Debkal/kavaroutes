import {useMemo} from 'react';
import type {DriverLeg} from '../cloud-driver-api';

// Run status belongs to the assignment, never to an individual pickup/drop-off.
export const driverLegLifecycle=(leg:DriverLeg)=>leg.execution?.lifecycle??'AWAITING_DISPATCH';
export const completedDriverLegs=(legs:readonly DriverLeg[])=>legs.filter(leg=>driverLegLifecycle(leg)==='COMPLETED');

type CompletedSequence={key:string;legs:DriverLeg[]};
const clientKey=(leg:DriverLeg)=>leg.riderReference?`rider:${leg.riderReference}`:`trip:${leg.tripId}`;
const place=(label:string)=>label.trim().replace(/\s+/g,' ').toLowerCase();

/** Read the whole itinerary before filtering: another client or an unfinished leg
 * interrupts a sequence. Waiting between connected legs does not. Never merge by
 * display name; separate clients can have the same name. */
export function groupCompletedDriverTrips(legs:readonly DriverLeg[]):CompletedSequence[]{
  const ordered=legs.map((leg,index)=>({leg,index,start:Date.parse(leg.plannedStartAt),end:Date.parse(leg.plannedEndAt)}));
  if(ordered.every(entry=>Number.isFinite(entry.start)&&Number.isFinite(entry.end)&&entry.end>=entry.start))
    ordered.sort((a,b)=>a.start-b.start||a.index-b.index);
  const groups:CompletedSequence[]=[];
  let prior:typeof ordered[number]|null=null;
  let current:CompletedSequence|null=null;
  for(const entry of ordered){
    const {leg}=entry;
    if(driverLegLifecycle(leg)!=='COMPLETED'){prior=null;current=null;continue;}
    const connected=current&&prior&&clientKey(prior.leg)===clientKey(leg)&&
      Number.isFinite(prior.start)&&Number.isFinite(prior.end)&&Number.isFinite(entry.start)&&Number.isFinite(entry.end)&&
      prior.end>=prior.start&&entry.end>=entry.start&&prior.end<=entry.start&&
      place(prior.leg.dropoffLabel)===place(leg.pickupLabel);
    if(connected)current!.legs.push(leg);
    else {current={key:leg.tripLegId,legs:[leg]};groups.push(current);}
    prior=entry;
  }
  return groups;
}

export function DriverCompletedTrips({legs}:{legs:readonly DriverLeg[]}){
  const groups=useMemo(()=>groupCompletedDriverTrips(legs),[legs]);
  if(!groups.length)return null;
  return <details className="driver-card" aria-label="Completed trips">
    <summary>Completed trips ({groups.length})</summary>
    <ul>{groups.map(group=><li key={group.key}>
      <strong>{group.legs[0]!.riderLabel}</strong> · {[group.legs[0]!.pickupLabel,...group.legs.map(leg=>leg.dropoffLabel)].join(' → ')} · Completed
      {group.legs.length>1&&<small> · {group.legs.length} legs</small>}
    </li>)}</ul>
  </details>;
}
