import {expect,it,vi} from 'vitest';
import {render,screen} from '@testing-library/react';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {RouteStreetMap} from '../src/components/RouteStreetMap';

it('shows an authorized street map for the selected shift and client without exposing the map key',async()=>{
  const client=new QueryClient({defaultOptions:{queries:{retry:false,gcTime:0}}});
  const shift='11111111-1111-4111-8111-111111111111';
  const clientId='22222222-2222-4222-8222-222222222222';
  const day='2026-09-25';
  const api={routeTraceMap:vi.fn(async()=>({value:{shiftReference:shift,serviceDate:day,clientId,fixCount:2,mapImageUrl:'data:image/png;base64,cG5n'}}))};
  const track={shiftReference:shift,driverLabel:'Joel',lastCapturedAt:`${day}T15:03:00Z`,trace:[{latitude:41.88,longitude:-87.62,capturedAt:`${day}T15:03:00Z`}]};
  render(<QueryClientProvider client={client}><RouteStreetMap api={api as never} day={day} clientId={clientId} track={track as never} history fallback={<p>Old plot</p>}/></QueryClientProvider>);
  const map=await screen.findByRole('img',{name:/street map with 2 recorded GPS fixes/});
  expect(map).toHaveAttribute('src','data:image/png;base64,cG5n');
  expect(api.routeTraceMap).toHaveBeenCalledWith(day,shift,clientId);
  expect(screen.getByText(/© OpenStreetMap contributors/)).toBeInTheDocument();
  expect(screen.queryByText('Old plot')).not.toBeInTheDocument();
  client.clear();
});
