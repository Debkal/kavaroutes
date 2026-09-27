import {it,expect} from 'vitest';
import {render,screen,fireEvent,within} from '@testing-library/react';
import {MemoryRouter} from 'react-router';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {DispatchRouteHistory} from '../src/components/DispatchRouteHistory';
import {routeHistoryRows} from '../src/route-history-csv';
import {csvBody,csvCell} from '../src/csv';

const day='2026-09-25',shift='11111111-1111-4111-8111-111111111111',driver='22222222-2222-4222-8222-222222222222';
const run='33333333-3333-4333-8333-333333333333',tripA='44444444-4444-4444-8444-444444444444',tripB='55555555-5555-4555-8555-555555555555';
const legA='66666666-6666-4666-8666-666666666666',legB='77777777-7777-4777-8777-777777777777';
const clientA='88888888-8888-4888-8888-888888888888',clientB='99999999-9999-4999-8999-999999999999';
const point=(minute:number)=>({latitude:41.88+minute/1000,longitude:-87.62-minute/1000,accuracyMeters:12,capturedAt:`${day}T15:${String(minute).padStart(2,'0')}:00.000Z`});
const trace=[point(1),point(3),point(5)];
const track={shiftReference:shift,driverId:driver,driverLabel:'Joel',plannedStartAt:`${day}T15:00:00.000Z`,serviceTimezone:'America/Chicago',startedAt:`${day}T15:00:00.000Z`,vehicleLabel:'Van 1',lifecycle:'SHIFT_ENDED',status:'SHIFT_ENDED',reason:'ACCEPTED_SIGN_OFF',contactDriver:false,silentSeconds:0,lastReceivedAt:trace[2]!.capturedAt,lastCapturedAt:trace[2]!.capturedAt,staleAfterSeconds:60,retryAfterSeconds:30,position:trace[2],trace};
const leg=(tripId:string,tripLegId:string,riderLabel:string)=>({runId:run,tripLegId,tripId,ordinal:1,riderLabel,pickupLabel:'Home',dropoffLabel:'Clinic',plannedStartAt:`${day}T15:00:00.000Z`,plannedEndAt:`${day}T16:00:00.000Z`,appointmentLengthMinutes:20,tripState:'completed',executionId:null,lifecycle:'completed',version:2});
const board={serviceDate:day,runs:[{runId:run,version:2,expectedTag:'',lifecycle:'completed',plannedStartAt:`${day}T15:00:00.000Z`,plannedEndAt:`${day}T16:00:00.000Z`,serviceTimezone:'America/Chicago',assignmentId:null,driverId:driver,vehicleId:null}],legs:[leg(tripA,legA,'Rider A'),leg(tripB,legB,'Rider B')],drivers:[{id:driver,label:'Joel'}],vehicles:[]};
const event=(kind:string,action:string,tripLegId:string|null,minute:number,outcome:string|null=null)=>({shiftReference:shift,runId:run,tripLegId,kind,action,outcome,reason:null,occurredAt:`${day}T15:${String(minute).padStart(2,'0')}:00.000Z`,recordedAt:`${day}T15:${String(minute).padStart(2,'0')}:00.000Z`});
const history={serviceDate:day,truncated:false,tripClients:[{tripId:tripA,clientId:clientA,clientLabel:'Client A'},{tripId:tripB,clientId:clientB,clientLabel:'Client B'}],events:[
  event('SHIFT_STARTED','SHIFT_STARTED',null,0),event('DRIVER_ACTION','MARK_EN_ROUTE',legA,2,'APPLIED'),event('DRIVER_ACTION','ARRIVE_PICKUP',legA,3,'APPLIED'),event('DRIVER_ACTION','COMPLETE_LEG',legA,4,'APPLIED'),
  event('DRIVER_ACTION','MARK_EN_ROUTE',legB,4,'APPLIED'),event('DRIVER_ACTION','COMPLETE_LEG',legB,6,'APPLIED'),event('SHIFT_CLOSURE','SIGN_OFF',null,7,'PASS'),
]};
const api={tracking:async()=>({value:{serviceDate:day,shifts:[track]}}),board:async()=>({value:board}),routeHistory:async()=>({value:history}),
  routeTraceMap:async()=>({value:{shiftReference:shift,serviceDate:day,clientId:null,fixCount:0,mapImageUrl:null}})};

it('filters real client accounts and bounds the displayed GPS fixes to their leg actions',async()=>{
  const client=new QueryClient({defaultOptions:{queries:{retry:false,gcTime:0}}});
  render(<MemoryRouter><QueryClientProvider client={client}><DispatchRouteHistory api={api as never} day={day} enabled/></QueryClientProvider></MemoryRouter>);
  await screen.findByText('Rider A');
  expect(screen.getByText('Rider B')).toBeInTheDocument();
  expect(screen.getAllByText(/Pickup arrival:/)).toHaveLength(2);
  fireEvent.change(screen.getByRole('combobox',{name:'Filter route history by client'}),{target:{value:clientA}});
  expect(screen.getByText('Rider A')).toBeInTheDocument();
  expect(screen.queryByText('Rider B')).not.toBeInTheDocument();
  expect(await screen.findByRole('img',{name:/trace of 1 fix/})).toBeInTheDocument();
  expect(screen.getByText('GPS fix log (1 fix)')).toBeInTheDocument();
  const eventList=screen.getByRole('list',{name:/recorded route events/i});
  expect(within(eventList).queryByText(/Rider B/)).not.toBeInTheDocument();
  client.clear();
});

it('exports rectangular leg, event and GPS rows while neutralizing formula cells',()=>{
  const rows=routeHistoryRows({day,track:track as never,board:board as never,history:history as never,trace:[trace[1]!],legIds:[legA]});
  expect(new Set(rows.map(row=>row.length))).toEqual(new Set([24]));
  expect(rows.filter(row=>row[0]==='LEG')).toHaveLength(1);
  expect(rows.filter(row=>row[0]==='GPS_FIX')).toHaveLength(1);
  expect(rows.some(row=>row.includes('Client B'))).toBe(false);
  expect(csvBody(rows)).toContain('ARRIVE_PICKUP');
  expect(csvCell('  =HYPERLINK("bad")')).toBe('"\'  =HYPERLINK(""bad"")"');
});
