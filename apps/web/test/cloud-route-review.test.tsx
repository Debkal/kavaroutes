import {it,expect,vi} from 'vitest';
import {render,screen,fireEvent} from '@testing-library/react';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {CloudRouteReview} from '../src/components/CloudRouteReview';
import {DevelopmentApiError} from '@kavaroutes/api-contracts/private-development-transport';
it('dispatcher recovers the identical decision after a lost response and refreshes committed state',async()=>{
 const shift='11111111-1111-4111-8111-111111111111',proposalId='22222222-2222-4222-8222-222222222222',node='33333333-3333-4333-8333-333333333333';
 const tag=`"kr1.${'a'.repeat(43)}"`,commands:unknown[]=[];
 let approved=false;
 const api:any={dispatchSnapshot:async()=>({value:{resources:[{kind:'driver-shift',reference:`driver-shift:${shift}`,version:1}]}}),
  routeProposals:async()=>({value:{shiftId:shift,runId:shift,runVersion:approved?2:1,factsVersion:1,shiftGeneration:shift,policyDigest:'a'.repeat(64),expectedTag:tag,mode:'DISPATCH_APPROVAL_REQUIRED',nodes:[{nodeId:node,tripLegId:shift,kind:'PICKUP',locked:false}],proposals:[{proposalId,expectedTag:tag,nodeOrder:[node],runVersion:1,state:approved?'APPROVED':'PENDING_DISPATCH_APPROVAL'}]}}),
  decideRoute:async(command:unknown)=>{commands.push(command);if(commands.length===1)throw new DevelopmentApiError(0,'OUTCOME_UNKNOWN');approved=true;return {value:{proposalId,runId:shift,runVersion:2,state:'APPROVED'}};}};
 const client=new QueryClient({defaultOptions:{queries:{retry:false,gcTime:0}}});
 render(<QueryClientProvider client={client}><CloudRouteReview api={api} day="2026-09-14" enabled/></QueryClientProvider>);
 await screen.findByRole('option',{name:'Shift 1 · version 1'});fireEvent.change(screen.getByLabelText('Recorded shift'),{target:{value:shift}});
 vi.spyOn(window,'confirm').mockReturnValue(true);
 fireEvent.click(await screen.findByRole('button',{name:'Approve proposal 1'}));await screen.findByText(/Outcome unknown/);
 expect(approved).toBe(false);fireEvent.click(screen.getByRole('button',{name:'Recover original decision'}));
 await screen.findByText('Server decision: APPROVED.');expect(commands).toHaveLength(2);expect(commands[0]).toEqual(commands[1]);
 await screen.findByText('Current route · version 2');client.clear();
});
