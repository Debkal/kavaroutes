import {it,expect,vi} from 'vitest';
import {act,render,screen} from '@testing-library/react';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {CloudTrackingStatus} from '../src/components/CloudTrackingStatus';
const shift='11111111-1111-4111-8111-111111111111';
const track=(overrides:Record<string,unknown>={})=>({serviceDate:'2026-09-14',shifts:[{shiftReference:shift,driverId:'22222222-2222-4222-8222-222222222222',
  driverLabel:'Synthetic Driver 042',plannedStartAt:'2026-09-14T15:00:00.000Z',serviceTimezone:'America/Los_Angeles',startedAt:'2026-09-14T14:58:00.000Z',vehicleLabel:'Synthetic Van 12',
  lifecycle:'ACTIVE',status:'UPDATES_OVERDUE',reason:'NO_RECENT_UPDATE_UNKNOWN_CAUSE',contactDriver:true,silentSeconds:142,
  lastReceivedAt:'2026-09-14T23:58:01Z',lastCapturedAt:'2026-09-14T23:58:00Z',staleAfterSeconds:60,retryAfterSeconds:30,
  position:{latitude:34.0522,longitude:-118.2437,accuracyMeters:12,capturedAt:'2026-09-14T23:58:00Z'},
  trace:[{latitude:34.0500,longitude:-118.2400,accuracyMeters:15,capturedAt:'2026-09-14T23:55:00Z'},
         {latitude:34.0522,longitude:-118.2437,accuracyMeters:12,capturedAt:'2026-09-14T23:58:00Z'}],...overrides}]});
const mount=(api:any)=>{const client=new QueryClient({defaultOptions:{queries:{retry:false,gcTime:0}}});
 render(<QueryClientProvider client={client}><CloudTrackingStatus api={{routeTraceMap:async()=>({value:{mapImageUrl:null}}),...api}} day="2026-09-14" enabled/></QueryClientProvider>);return client;};

it('shows one card per driver, named by part of day, with the lost-signal account',async()=>{
 const client=mount({tracking:async()=>({value:track()}),shiftStatus:async()=>({value:{tracking:{status:'UPDATES_OVERDUE',reason:'NO_RECENT_UPDATE_UNKNOWN_CAUSE',contactDriver:true,evaluatedAt:'2026-09-15T00:00:00Z',lastCapturedAt:'2026-09-14T23:58:00Z',lastReceivedAt:'2026-09-14T23:58:01Z',staleAfterSeconds:60}}})});
 // 15:00Z is 08:00 in the business timezone: a morning shift, named, not numbered.
 await screen.findByRole('button',{name:/Synthetic Driver 042/});
 expect(screen.queryByText(/shift [0-9a-f]{8}/i)).not.toBeInTheDocument();
 expect(screen.getByText(/Synthetic Van 12 · started/)).toBeInTheDocument();
 const alerts=screen.getAllByRole('alert').map(node=>node.textContent??'');
 expect(alerts.some(text=>text.includes('No location update for 142 s'))).toBe(true);
 expect(screen.getAllByText('Lost signal')).toHaveLength(2);
 expect(await screen.findByRole('img',{name:/trace of 2 fixes/})).toBeInTheDocument();
 expect(screen.getByRole('link',{name:'Open last position in maps'})).toHaveAttribute('target','_blank');
 client.clear();
});

it('names an ended shift as ended and stops asking for a fix',async()=>{
 const client=mount({tracking:async()=>({value:track({lifecycle:'SHIFT_ENDED',status:'SHIFT_ENDED',reason:'ACCEPTED_SIGN_OFF',contactDriver:false,silentSeconds:0})})});
 await screen.findByRole('link',{name:'Review route history and GPS trace'});
 expect(screen.getByText(/No active driver shifts/)).toBeInTheDocument();
 expect(screen.queryByRole('link',{name:'Open last position in maps'})).not.toBeInTheDocument();
 client.clear();
});

it('does not blame the driver when dispatch cannot reach the backend',async()=>{
 const client=mount({tracking:async()=>{throw new Error('offline');}});
 await screen.findByText('Driver positions unavailable. The map is not current; verify with the driver before acting.');
 expect(screen.queryByText(/Synthetic Driver 042/)).not.toBeInTheDocument();client.clear();
});

it('refreshes the active list automatically as saved fixes arrive',async()=>{
 let current=track({position:null,trace:[],status:'NO_UPDATES',contactDriver:false,lastCapturedAt:null});
 const callbacks:Function[]=[];
 const interval=vi.spyOn(window,'setInterval').mockImplementation((callback:TimerHandler)=>{callbacks.push(callback as Function);return 1;});
 const client=mount({tracking:async()=>({value:current})});
 await screen.findByText('Waiting for the first saved location fix.');
 current=track({status:'UPDATES_CURRENT',contactDriver:false,silentSeconds:0});
 await act(async()=>{await callbacks[0]!();});
 expect(screen.getAllByText('Live')).toHaveLength(2);
 expect(screen.getByText(/Last saved fix/)).toBeInTheDocument();
 interval.mockRestore();client.clear();
});

it('breaks the plotted path when tracking has an unobserved gap',async()=>{
 const trace=[
  {latitude:34.0500,longitude:-118.2400,accuracyMeters:15,capturedAt:'2026-09-14T23:55:00Z'},
  {latitude:34.0501,longitude:-118.2401,accuracyMeters:15,capturedAt:'2026-09-14T23:55:10Z'},
  {latitude:34.0522,longitude:-118.2437,accuracyMeters:12,capturedAt:'2026-09-14T23:58:00Z'},
 ];
 const client=mount({tracking:async()=>({value:track({trace,position:trace[2]})})});
 expect(await screen.findByRole('img',{name:/1 tracking gap/})).toBeInTheDocument();
 const lines=document.querySelectorAll('.driver-trace-line');
 expect(lines).toHaveLength(1);
 expect(lines[0]!.getAttribute('points')!.split(' ')).toHaveLength(2);
 expect(screen.getByText(/1 unobserved gap/)).toBeInTheDocument();
 client.clear();
});

it('keeps a newer manual refresh when an earlier poll finishes later',async()=>{
 let finishOld:(value:any)=>void=()=>{};
 let calls=0;
 const api={tracking:vi.fn(()=>{
  calls++;
  if(calls===1)return Promise.resolve({value:track({driverLabel:'Initial driver'})});
  if(calls===2)return new Promise(resolve=>{finishOld=resolve;});
  return Promise.resolve({value:track({driverLabel:'Fresh driver'})});
 })};
 const callbacks:Function[]=[];
 const interval=vi.spyOn(window,'setInterval').mockImplementation((callback:TimerHandler)=>{callbacks.push(callback as Function);return 1;});
 const client=mount(api);
 await screen.findByRole('button',{name:/Initial driver/});
 act(()=>{void callbacks[0]!();});
 act(()=>{screen.getByRole('button',{name:'Refresh tracking'}).click();});
 await screen.findByRole('button',{name:/Fresh driver/});
 await act(async()=>{finishOld({value:track({driverLabel:'Stale driver'})});});
 expect(screen.queryByRole('button',{name:/Stale driver/})).not.toBeInTheDocument();
 expect(screen.getByRole('button',{name:/Fresh driver/})).toBeInTheDocument();
 interval.mockRestore();client.clear();
});
