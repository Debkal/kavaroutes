import {it,expect,vi,afterEach} from 'vitest';
import {render,screen,fireEvent,waitFor,cleanup} from '@testing-library/react';
import {QueryClientProvider} from '@tanstack/react-query';
import {queryClient} from '../src/runtime';
import {Component,loader} from '../src/routes/cloud-facility-route';
const mocks=vi.hoisted(()=>({authenticate:vi.fn(),day:vi.fn(),trip:vi.fn()}));
vi.mock('../src/cloud-facility-api',()=>({createCloudFacilityApi:()=>mocks}));
const trip={relatedTripReference:'11111111-1111-4111-8111-111111111111',lifecycle:'COMPLETED',scheduledAt:'2026-09-14T15:00:00Z'};
afterEach(()=>{cleanup();queryClient.clear();vi.clearAllMocks();});
it('clears previous role cache and hides details after facility access is revoked',async()=>{
 queryClient.setQueryData(['private-cloud','dispatcher','trip'],{canary:'dispatcher-only'});
 loader({request:new Request('http://127.0.0.1/facility')} as any);expect(queryClient.getQueryCache().getAll()).toHaveLength(0);
 mocks.authenticate.mockResolvedValue({value:{}});mocks.day.mockResolvedValue({value:{items:[trip],nextAfter:null}});mocks.trip.mockResolvedValue({value:trip});
 render(<QueryClientProvider client={queryClient}><Component/></QueryClientProvider>);
 fireEvent.click(await screen.findByText('View trip 1'));
 await screen.findByRole('region',{name:'Selected client trip'});
 await waitFor(()=>expect(mocks.trip).toHaveBeenCalled());
 mocks.day.mockResolvedValue({value:{items:[],nextAfter:null}});mocks.trip.mockRejectedValue(new Error('revoked'));
 fireEvent.click(screen.getByText('Refresh client trips'));
 await screen.findByText('Trip no longer available to this client. Previous details are hidden.');
 expect(screen.queryByText('View trip 1')).not.toBeInTheDocument();expect(screen.queryByText(/COMPLETED/)).not.toBeInTheDocument();
});
it('authentication failure never requests or renders a facility projection and URL context is rejected',async()=>{
 mocks.authenticate.mockRejectedValue(new Error('expired'));
 expect(()=>loader({request:new Request('http://127.0.0.1/facility?trip=foreign')} as any)).toThrow();
 render(<QueryClientProvider client={queryClient}><Component/></QueryClientProvider>);
 await screen.findByText('Client session unavailable. No previous trip data is shown.');expect(mocks.day).not.toHaveBeenCalled();
});
