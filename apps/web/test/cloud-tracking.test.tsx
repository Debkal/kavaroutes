import {it,expect} from 'vitest';
import {render,screen} from '@testing-library/react';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {CloudTrackingStatus} from '../src/components/CloudTrackingStatus';
const shift='11111111-1111-4111-8111-111111111111';
const track=(overrides:Record<string,unknown>={})=>({serviceDate:'2026-09-14',shifts:[{shiftReference:shift,driverId:'22222222-2222-4222-8222-222222222222',
  driverLabel:'Synthetic Driver 042',lifecycle:'ACTIVE',status:'UPDATES_OVERDUE',reason:'NO_RECENT_UPDATE_UNKNOWN_CAUSE',contactDriver:true,silentSeconds:142,
  lastReceivedAt:'2026-09-14T23:58:01Z',lastCapturedAt:'2026-09-14T23:58:00Z',staleAfterSeconds:60,retryAfterSeconds:30,
  position:{latitude:34.0522,longitude:-118.2437,accuracyMeters:12,capturedAt:'2026-09-14T23:58:00Z'},
  trace:[{latitude:34.0500,longitude:-118.2400,accuracyMeters:15,capturedAt:'2026-09-14T23:55:00Z'},
         {latitude:34.0522,longitude:-118.2437,accuracyMeters:12,capturedAt:'2026-09-14T23:58:00Z'}],...overrides}]});
it('shows actionable overdue transmission without attributing a cause',async()=>{
 const client=new QueryClient({defaultOptions:{queries:{retry:false,gcTime:0}}});
 const api:any={dispatchSnapshot:async()=>({value:{resources:[{kind:'driver-shift',reference:`driver-shift:${shift}`,version:1}]}}),shiftStatus:async()=>({value:{tracking:{status:'UPDATES_OVERDUE',reason:'NO_RECENT_UPDATE_UNKNOWN_CAUSE',contactDriver:true,evaluatedAt:'2026-09-15T00:00:00Z',lastCapturedAt:'2026-09-14T23:58:00Z',lastReceivedAt:'2026-09-14T23:58:01Z',staleAfterSeconds:60}}}),tracking:async()=>({value:track()})};
 render(<QueryClientProvider client={client}><CloudTrackingStatus api={api} day="2026-09-14" enabled/></QueryClientProvider>);
 await screen.findByText('Shift 1: Updates overdue — contact driver');const alerts=screen.getAllByRole('alert').map(node=>node.textContent??'');
expect(alerts.some(text=>text.includes('Contact the driver'))).toBe(true);
expect(alerts.some(text=>text.includes('No location update for 142 s'))).toBe(true);
expect(screen.getByRole('img',{name:/trace of 2 fixes/})).toBeInTheDocument();
expect(screen.getByText('NO RECENT UPDATE UNKNOWN CAUSE')).toBeInTheDocument();client.clear();
});
it('does not blame the driver when dispatch cannot reach the backend',async()=>{
 const client=new QueryClient({defaultOptions:{queries:{retry:false,gcTime:0}}});
 render(<QueryClientProvider client={client}><CloudTrackingStatus api={{dispatchSnapshot:async()=>{throw new Error('offline');},tracking:async()=>{throw new Error('offline');}} as any} day="2026-09-14" enabled/></QueryClientProvider>);
 await screen.findByText('Dispatch connection unavailable. Tracking status cannot be verified; this does not prove a driver lost signal.');expect(screen.queryByText(/Shift 1:/)).not.toBeInTheDocument();client.clear();
});
