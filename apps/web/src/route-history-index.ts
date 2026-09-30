import type {createCloudApi} from './cloud-api';
type Api=ReturnType<typeof createCloudApi>;
type Event=Awaited<ReturnType<Api['routeHistory']>>['value']['events'][number];
type Leg=Awaited<ReturnType<Api['board']>>['value']['legs'][number];

/** One bottom-up pass over the day replaces repeated scans for every shift,
 * leg and displayed event. First-applied semantics match the recorded report. */
export function indexRouteHistory(events:readonly Event[],legs:readonly Leg[]){
  const runByShift=new Map<string,string>();
  const eventsByShift=new Map<string,Event[]>();
  const actions=new Map<string,Event>();
  for(const event of events){
    const group=eventsByShift.get(event.shiftReference);
    if(group)group.push(event);else eventsByShift.set(event.shiftReference,[event]);
    if(event.kind==='SHIFT_STARTED'&&!runByShift.has(event.shiftReference))runByShift.set(event.shiftReference,event.runId);
    if(event.kind==='DRIVER_ACTION'&&event.outcome==='APPLIED'&&event.tripLegId){
      const key=`${event.shiftReference}:${event.tripLegId}:${event.action}`;
      if(!actions.has(key))actions.set(key,event);
    }
  }
  const legsByRun=new Map<string,Leg[]>(),legById=new Map<string,Leg>();
  for(const leg of legs){
    legById.set(leg.tripLegId,leg);
    const group=legsByRun.get(leg.runId);
    if(group)group.push(leg);else legsByRun.set(leg.runId,[leg]);
  }
  return {runByShift,eventsByShift,legsByRun,legById,
    applied:(shift:string,leg:string,action:string)=>actions.get(`${shift}:${leg}:${action}`)??null};
}
