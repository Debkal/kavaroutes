import {it,expect,vi} from 'vitest';
import {act,render,screen} from '@testing-library/react';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {CloudTrackingStatus} from '../src/components/CloudTrackingStatus';
const shift='11111111-1111-4111-8111-111111111111';
const track=(overrides:Record<string,unknown>={})=>({serviceDate:'2026-09-14',shifts:[{shiftReference:shift,driverId:'22222222-2222-4222-8222-222222222222',
  driverLabel:'Synthetic Driver 042',plannedStartAt:'2026-09-14T15:00:00.000Z',startedAt:'2026-09-14T14:58:00.000Z',vehicleLabel:'Synthetic Van 12',
  lifecycle:'ACTIVE',status:'UPDATES_OVERDUE',reason:'NO_RECENT_UPDATE_UNKNOWN_CAUSE',contactDriver:true,silentSeconds:142,
  lastReceivedAt:'2026-09-14T23:58:01Z',lastCapturedAt:'2026-09-14T23:58:00Z',staleAfterSeconds:60,retryAfterSeconds:30,
  position:{latitude:34.0522,longitude:-118.2437,accuracyMeters:12,capturedAt:'2026-09-14T23:58:00Z'},
  trace:[{latitude:34.0500,longitude:-118.2400,accuracyMeters:15,capturedAt:'2026-09-14T23:55:00Z'},
         {latitude:34.0522,longitude:-118.2437,accuracyMeters:12,capturedAt:'2026-09-14T23:58:00Z'}],...overrides}]});
const mount=(api:any)=>{const client=new QueryClient({defaultOptions:{queries:{retry:false,gcTime:0}}});
 render(<QueryClientProvider client={client}><CloudTrackingStatus api={api} day="2026-09-14" enabled/></QueryClientProvider>);return client;};

it('shows one card per driver, named by part of day, with the lost-signal account',async()=>{
 const client=mount({tracking:async()=>({value:track()}),shiftStatus:async()=>({value:{tracking:{status:'UPDATES_OVERDUE',reason:'NO_RECENT_UPDATE_UNKNOWN_CAUSE',contactDriver:true,evaluatedAt:'2026-09-15T00:00:00Z',lastCapturedAt:'2026-09-14T23:58:00Z',lastReceivedAt:'2026-09-14T23:58:01Z',staleAfterSeconds:60}}})});
 // 15:00Z is 08:00 in the business timezone: a morning shift, named, not numbered.
 await screen.findByRole('button',{name:/Synthetic Driver 042/});
 expect(screen.queryByText(/shift [0-9a-f]{8}/i)).not.toBeInTheDocument();
 expect(screen.getByText(/Synthetic Van 12 · started/)).toBeInTheDocument();
 const alerts=screen.getAllByRole('alert').map(node=>node.textContent??'');
 expect(alerts.some(text=>text.includes('No location update for 142 s'))).toBe(true);
 expect(screen.getAllByText('Lost signal')).toHaveLength(2);
 expect(screen.getByRole('img',{name:/trace of 2 fixes/})).toBeInTheDocument();
 expect(screen.getByRole('link',{name:'Open last position in maps'})).toHaveAttribute('target','_blank');
 client.clear();
});

it('names an ended shift as ended and stops asking for a fix',async()=>{
 const client=mount({tracking:async()=>({value:track({lifecycle:'SHIFT_ENDED',status:'SHIFT_ENDED',reason:'ACCEPTED_SIGN_OFF',contactDriver:false,silentSeconds:0})})});
 await screen.findByText('1 completed shift');
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
