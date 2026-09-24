import {it,expect,vi} from 'vitest';
import {fireEvent,render,screen} from '@testing-library/react';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {RoadRoutePlanner} from '../src/components/RoadRoutePlanner';
import {DriverRoadDirections} from '../src/components/DriverRoadDirections';

const legId='11111111-1111-4111-8111-111111111111';
const leg={runId:'22222222-2222-4222-8222-222222222222',tripLegId:legId,tripId:'33333333-3333-4333-8333-333333333333',ordinal:1,
  riderLabel:'Rider',pickupLabel:'1 Main St',dropoffLabel:'2 Main St',plannedStartAt:'2026-09-24T15:00:00Z',plannedEndAt:'2026-09-24T16:00:00Z',
  appointmentLengthMinutes:0,tripState:'scheduled',executionId:null,lifecycle:'planned',version:0};
const preview={goal:'FASTEST',provider:'GOOGLE_ROUTES',distanceMeters:10000,durationSeconds:800,tollEstimate:null,tollsExpected:false,
  maneuverCount:2,pathFingerprint:'a'.repeat(64),steps:[{instruction:'Turn right on Main St',maneuver:'TURN_RIGHT',distanceMeters:200}],
  mapImageUrl:'https://maps.googleapis.com/maps/api/staticmap?size=640x360&key=test',googleMapsUrl:'https://www.google.com/maps/dir/?api=1&origin=1%2C2&destination=3%2C4',note:'Traffic-aware.'};

it('generates a map only after choosing a goal and saves that goal for the driver',async()=>{
  const api={roadRouteSelection:vi.fn(async()=>({value:{goal:null,version:0,selectedAt:null}})),
    previewRoadRoute:vi.fn(async()=>({value:preview})),
    selectRoadRoute:vi.fn(async()=>({value:{goal:'FASTEST',version:1,selectedAt:'2026-09-23T12:00:00Z'}}))};
  render(<RoadRoutePlanner api={api as any} legs={[leg]} enabled/>);
  expect(api.previewRoadRoute).not.toHaveBeenCalled();
  await screen.findByLabelText('Route goal');
  fireEvent.change(screen.getByLabelText('Route goal'),{target:{value:'FASTEST'}});
  await screen.findByRole('img',{name:/Fastest drive road map/});
  expect(screen.getByRole('img',{name:/Fastest drive road map/})).toHaveAttribute('src',preview.mapImageUrl);
  expect(api.previewRoadRoute).toHaveBeenCalledWith(legId,'FASTEST');
  fireEvent.click(screen.getByRole('button',{name:'Choose for driver'}));
  await screen.findByText(/Route choice saved/);
  expect(api.selectRoadRoute).toHaveBeenCalledWith(legId,'FASTEST',0,expect.stringMatching(/^road-select-/));
});

it('shows the assigned driver fresh turn instructions and a Google Maps directions link',async()=>{
  const api={roadRoute:vi.fn(async()=>({value:{selection:{goal:'FASTEST',version:1,selectedAt:'2026-09-23T12:00:00Z'},route:{...preview,mapImageUrl:null}}}))};
  const client=new QueryClient({defaultOptions:{queries:{retry:false,gcTime:0}}});
  render(<QueryClientProvider client={client}><DriverRoadDirections api={api as any} legId={legId} pickup="1 Main St" dropoff="2 Main St"/></QueryClientProvider>);
  await screen.findByText(/Dispatch chose/);
  expect(screen.getByRole('link',{name:'Open selected route in Google Maps'})).toHaveAttribute('href',preview.googleMapsUrl);
  fireEvent.click(screen.getByText(/Turn-by-turn directions/));
  expect(screen.getByText('Turn right on Main St')).toBeInTheDocument();
  client.clear();
});
