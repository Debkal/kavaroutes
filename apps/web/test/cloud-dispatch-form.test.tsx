import {describe,it,expect,vi} from 'vitest';
import {render,screen,fireEvent} from '@testing-library/react';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {DispatchRouteForm} from '../src/components/DispatchRouteForm';
import type {createCloudApi} from '../src/cloud-api';

// The form reads the client roster over its own scoped transport. This lane has no
// server, so the roster is stubbed empty and the form is exercised as manual entry —
// the same shape a dispatch operator sees when the roster read fails.
vi.mock('../src/cloud-client-api',()=>({createCloudClientApi:()=>({roster:async()=>({value:{clients:[]}}),create:async()=>{throw new Error('NOT_STUBBED');},update:async()=>{throw new Error('NOT_STUBBED');}})}));
function mount(){const client=new QueryClient({defaultOptions:{queries:{retry:false,gcTime:0}}});
 render(<QueryClientProvider client={client}><DispatchRouteForm api={{} as ReturnType<typeof createCloudApi>} serviceDate="2026-09-17" onServiceDateChange={()=>{}}/></QueryClientProvider>);}
describe('dispatch route entry controls',()=>{
 it('adds a trip from the same pickup, and says so, rather than promising an extra drop-off (WEB-A-030)',()=>{
  mount();
  expect(screen.getByText('Trip 1')).toBeTruthy();
  const pickup=screen.getByLabelText('Pickup address') as HTMLInputElement;
  fireEvent.change(pickup,{target:{value:'100 Synthetic Way'}});
  fireEvent.change(screen.getByLabelText('Drop-off address'),{target:{value:'200 Synthetic Clinic'}});
  fireEvent.click(screen.getByRole('button',{name:'Add another trip from this pickup'}));
  expect(screen.getByText('Trip 2')).toBeTruthy();
  const pickups=screen.getAllByLabelText('Pickup address') as HTMLInputElement[];
  expect(pickups.map(input=>input.value)).toEqual(['100 Synthetic Way','100 Synthetic Way']);
  expect((screen.getAllByLabelText('Drop-off address') as HTMLInputElement[]).map(input=>input.value)).toEqual(['200 Synthetic Clinic','']);
 });
 it('keeps a blank trip blank, and generates the return leg of a round trip',()=>{
  mount();
  fireEvent.click(screen.getByRole('button',{name:'Add a blank trip'}));
  expect((screen.getAllByLabelText('Pickup address') as HTMLInputElement[]).map(input=>input.value)).toEqual(['','']);
  fireEvent.change(screen.getAllByLabelText('Pickup address')[0]!,{target:{value:'100 Synthetic Way'}});
  fireEvent.change(screen.getAllByLabelText('Drop-off address')[0]!,{target:{value:'200 Synthetic Clinic'}});
  fireEvent.change(screen.getAllByLabelText(/Trip type/)[0]!,{target:{value:'ROUND_TRIP'}});
  const legends=screen.getAllByText(/^Trip \d+|^Return trip/).map(node=>node.textContent);
  expect(legends).toContain('Return trip 3 (generated from its outbound leg)');
 });
});
