import {expect,it,vi} from 'vitest';
import {fireEvent,render,screen} from '@testing-library/react';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {CloudReturnReview} from '../src/components/CloudReturnReview';

vi.mock('../src/components/CloudCommandRecovery',()=>({CloudCommandRecovery:()=>null}));
const shift='11111111-1111-4111-8111-111111111111';
function mount(closurePath:'RETURN_EXCEPTION'|'EMERGENCY_STOP'){
 const api={returnReview:async()=>({value:{shiftReference:shift,shiftGeneration:shift,resourceVersion:2,
  exceptionCommandId:'22222222-2222-4222-8222-222222222222',lifecycle:'ACTIVE',returnMode:'REQUIRED_WITH_AUDITED_OVERRIDE',
  returnResult:'UNAVAILABLE',closurePath}})};
 const client=new QueryClient({defaultOptions:{queries:{retry:false,gcTime:0}}});
 render(<QueryClientProvider client={client}><CloudReturnReview api={api as any} shift={shift}/></QueryClientProvider>);
 fireEvent.click(screen.getByRole('button',{name:'Open authorized return review'}));
 return client;
}

it('shows the unresolved-riders acknowledgement only for emergency resolution',async()=>{
 const normal=mount('RETURN_EXCEPTION');
 await screen.findByText(/Recorded exception: UNAVAILABLE/);
 expect(screen.queryByRole('checkbox',{name:/unresolved riders/})).not.toBeInTheDocument();
 normal.clear();
});

it('places the emergency acknowledgement next to its explanation',async()=>{
 const emergency=mount('EMERGENCY_STOP');
 await screen.findByText(/emergency-stopped with riders unresolved/);
 expect(screen.getByRole('checkbox',{name:/I acknowledge unresolved riders/})).toBeInTheDocument();
 emergency.clear();
});
