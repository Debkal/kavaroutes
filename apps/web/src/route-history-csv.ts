import type {createCloudApi} from './cloud-api';
import type {CloudBoard} from './cloud-board-contract';
import type {CsvCell,CsvRow} from './csv';

type Api=ReturnType<typeof createCloudApi>;
type Track=Awaited<ReturnType<Api['tracking']>>['value']['shifts'][number];
type History=Awaited<ReturnType<Api['routeHistory']>>['value'];
const columns=['Record type','Service date','Shift ID','Run ID','Trip ID','Leg ID','Client','Driver','Vehicle','Rider','Pickup','Drop-off','Planned start','Planned end','Leg status','Event','Outcome','Reason','Occurred at','Recorded at','Latitude','Longitude','Accuracy meters','Gap seconds'] as const;
type Column=typeof columns[number];
const record=(values:Partial<Record<Column,CsvCell>>):CsvRow=>columns.map(column=>values[column]??'');

/** One rectangular CSV: shift, trip legs, action receipts and GPS fixes can be
 * filtered together without silently dropping the raw trace. */
export function routeHistoryRows(input:{day:string;track:Track;board:CloudBoard;history:History;trace:Track['trace'];legIds:readonly string[]}):CsvRow[]{
  const {day,track,board,history,trace,legIds}=input;
  const runId=history.events.find(event=>event.shiftReference===track.shiftReference&&event.kind==='SHIFT_STARTED')?.runId??'';
  const legs=board.legs.filter(leg=>leg.runId===runId&&legIds.includes(leg.tripLegId));
  const clients=new Map(history.tripClients.map(item=>[item.tripId,item.clientLabel]));
  const events=history.events.filter(event=>event.shiftReference===track.shiftReference&&(event.tripLegId===null||legIds.includes(event.tripLegId)));
  const base={'Service date':day,'Shift ID':track.shiftReference,'Run ID':runId,'Driver':track.driverLabel,'Vehicle':track.vehicleLabel??''};
  const rows:CsvRow[]=[columns,
    record({...base,'Record type':'SHIFT','Occurred at':track.startedAt}),
    ...legs.map(leg=>record({...base,'Record type':'LEG','Trip ID':leg.tripId,'Leg ID':leg.tripLegId,'Client':clients.get(leg.tripId)??'',
      'Rider':leg.riderLabel,'Pickup':leg.pickupLabel,'Drop-off':leg.dropoffLabel,'Planned start':leg.plannedStartAt,
      'Planned end':leg.plannedEndAt,'Leg status':leg.lifecycle})),
    ...events.map(event=>record({...base,'Record type':'EVENT','Leg ID':event.tripLegId??'','Event':event.action,
      'Outcome':event.outcome??'','Reason':event.reason??'','Occurred at':event.occurredAt,'Recorded at':event.recordedAt})),
    ...trace.map((point,index)=>record({...base,'Record type':'GPS_FIX','Occurred at':point.capturedAt,
      'Latitude':point.latitude,'Longitude':point.longitude,'Accuracy meters':point.accuracyMeters??'',
      'Gap seconds':index?Math.max(0,Math.round((Date.parse(point.capturedAt)-Date.parse(trace[index-1]!.capturedAt))/1000)):0})),
  ];
  if(history.truncated||track.trace.length===500)rows.push(record({...base,'Record type':'DATA_LIMIT',
    'Reason':[history.truncated?'Event list exceeds 3000 rows':'',track.trace.length===500?'GPS may have earlier fixes outside the latest 500':''].filter(Boolean).join('; ')}));
  return rows;
}
