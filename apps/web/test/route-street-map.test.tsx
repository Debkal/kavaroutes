import {expect,it,vi} from 'vitest';
import {fireEvent,render,screen} from '@testing-library/react';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {RouteStreetMap} from '../src/components/RouteStreetMap';

vi.mock('leaflet',()=>{
  const layer=()=>({addTo(){return this;},bindTooltip(){return this;}});
  return {default:{map:()=>({remove(){},removeLayer(){},fitBounds(){},invalidateSize(){}}),
    TileLayer:{extend:()=>class{addTo(){}}},layerGroup:layer,polyline:layer,circleMarker:layer,
    latLngBounds:()=>({extend(){},pad(){return this;}})}};
});

it('shows the full shift on an interactive street map and can inspect raw GPS without exposing the provider key',async()=>{
  const client=new QueryClient({defaultOptions:{queries:{retry:false,gcTime:0}}});
  const shift='11111111-1111-4111-8111-111111111111',clientId='22222222-2222-4222-8222-222222222222',day='2026-09-25';
  const points=[{latitude:41.88,longitude:-87.62,accuracyMeters:3,capturedAt:`${day}T15:02:30Z`,window:1},
    {latitude:41.881,longitude:-87.621,accuracyMeters:3,capturedAt:`${day}T15:03:00Z`,window:1}];
  const api={fullTrace:vi.fn(async()=>({value:{shiftReference:shift,serviceDate:day,clientId,fixCount:2,truncated:false,points}})),
    traceMatch:vi.fn(async()=>({value:{status:'READY',segments:[[[41.88,-87.62],[41.881,-87.621]]],windows:[1]}})),mapTile:vi.fn()};
  const track={shiftReference:shift,driverLabel:'Joel',startedAt:`${day}T15:00:00Z`,trace:points};
  render(<QueryClientProvider client={client}><RouteStreetMap api={api as never} day={day} clientId={clientId} track={track as never} history fallback={<p>Old plot</p>}/></QueryClientProvider>);
  expect(await screen.findByRole('region',{name:/Interactive street map/})).toBeInTheDocument();
  expect(await screen.findByText(/2 of 2 saved GPS fixes shown/)).toBeInTheDocument();
  expect(api.fullTrace).toHaveBeenCalledWith(day,shift,clientId);
  expect(screen.getByRole('link',{name:/Open approximate directions in Google Maps/})).toHaveAttribute('href',expect.stringContaining('https://www.google.com/maps/dir/?api=1'));
  fireEvent.click(screen.getByRole('button',{name:'Show raw GPS'}));
  expect(screen.getByRole('button',{name:'Show road-aligned path'})).toHaveAttribute('aria-pressed','true');
  expect(document.body.textContent).not.toContain('private-key');
  expect(screen.queryByText('Old plot')).not.toBeInTheDocument();
  client.clear();
});
