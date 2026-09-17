import {describe,it,expect,vi} from 'vitest';
import {render,screen,fireEvent,waitFor} from '@testing-library/react';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {CloudBoard} from '../src/components/CloudBoard';
import {decodeCloudBoard,decodeCloudAssignment} from '../src/cloud-board-contract';
import type {createCloudApi} from '../src/cloud-api';
import {DevelopmentApiError} from '@kavaroutes/api-contracts/private-development-transport';
vi.mock('../src/cloud-live',()=>({connectCloudDispatch:()=>()=>{}}));
const runId='11111111-1111-4111-8111-111111111111',driverId='22222222-2222-4222-8222-222222222222',vehicleId='33333333-3333-4333-8333-333333333333';
const assignmentId='44444444-4444-4444-8444-444444444444',expectedTag=`"kr1.${'a'.repeat(43)}"`;
const fixture=()=>({serviceDate:'2026-09-14',runs:[{runId,version:1,expectedTag,lifecycle:'planned',plannedStartAt:'2026-09-14T16:00:00Z',plannedEndAt:'2026-09-14T17:00:00Z',serviceTimezone:'America/Los_Angeles',assignmentId:null as string|null,driverId:null as string|null,vehicleId:null as string|null}],legs:[],drivers:[{id:driverId,label:'Synthetic Driver'}],vehicles:[{id:vehicleId,label:'Synthetic Van'}]});
function mount(api:unknown){const client=new QueryClient({defaultOptions:{queries:{retry:false,gcTime:0}}});render(<QueryClientProvider client={client}><CloudBoard api={api as ReturnType<typeof createCloudApi>} enabled/></QueryClientProvider>);return client;}
describe('cloud dispatch authority',()=>{
 it('rejects wrong-day, unknown-field and ambiguous board responses',()=>{
  expect(decodeCloudBoard(fixture(),'2026-09-14').runs).toHaveLength(1);
  expect(()=>decodeCloudBoard(fixture(),'2026-09-15')).toThrow();
  expect(()=>decodeCloudBoard({...fixture(),billing:[]},'2026-09-14')).toThrow();
  expect(()=>decodeCloudBoard({...fixture(),runs:[...fixture().runs,...fixture().runs]},'2026-09-14')).toThrow();
  expect(()=>decodeCloudAssignment({assignmentId,runId,version:9,serviceDate:'2026-09-14'},{runId,driverId,vehicleId,expectedTag,expectedVersion:1,key:'stable'})).toThrow();
 });
 it('recovers a lost acknowledgement with the identical command, never local acceptance',async()=>{
  const board=fixture();const commands:unknown[]=[];let calls=0;
  const assign=vi.fn(async(command:unknown)=>{commands.push(command);if(++calls===1)throw new DevelopmentApiError(0,'OUTCOME_UNKNOWN');board.runs[0]={...board.runs[0]!,assignmentId,driverId,vehicleId,version:2};return {value:{assignmentId,runId,version:2,serviceDate:board.serviceDate}};});
  const client=mount({board:async()=>({value:structuredClone(board)}),assign});
  vi.spyOn(window,'confirm').mockReturnValue(true);
  fireEvent.click(await screen.findByRole('button',{name:'View run 1'}));
  fireEvent.change(screen.getByLabelText('Driver'),{target:{value:driverId}});
  fireEvent.change(screen.getByLabelText('Vehicle'),{target:{value:vehicleId}});
  fireEvent.click(screen.getByRole('button',{name:'Confirm assignment'}));
  await screen.findByText(/Outcome unknown/);
  expect(screen.queryByText('Assignment confirmed by the server. Driver itinerary updated.')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button',{name:'Recover original assignment'}));
  await screen.findByText('Assignment confirmed by the server. Driver itinerary updated.');
  expect(commands[0]).toEqual(commands[1]);expect(assign).toHaveBeenCalledTimes(2);client.clear();
 });
 it('refreshes a conflict without applying optimistic assignment',async()=>{
  const board=vi.fn(async()=>({value:fixture()}));
  const client=mount({board,assign:async()=>{throw new DevelopmentApiError(412,'VERSION_CONFLICT');}});
  vi.spyOn(window,'confirm').mockReturnValue(true);
  fireEvent.click(await screen.findByRole('button',{name:'View run 1'}));
  fireEvent.change(screen.getByLabelText('Driver'),{target:{value:driverId}});fireEvent.change(screen.getByLabelText('Vehicle'),{target:{value:vehicleId}});
  fireEvent.click(screen.getByRole('button',{name:'Confirm assignment'}));
 await screen.findByText('Conflict. Refresh and review the current records before retrying.');
 await waitFor(()=>expect(board.mock.calls.length).toBeGreaterThan(1));
 expect(screen.queryByRole('button',{name:'Recover original assignment'})).not.toBeInTheDocument();client.clear();
});
 it('names the constraint the backend refused instead of one generic rejection',async()=>{
  const board=vi.fn(async()=>({value:fixture()}));
  const client=mount({board,assign:async()=>{throw new DevelopmentApiError(409,'PERSISTENCE_FEASIBILITY');}});
  vi.spyOn(window,'confirm').mockReturnValue(true);
  fireEvent.click(await screen.findByRole('button',{name:'View run 1'}));
  fireEvent.change(screen.getByLabelText('Driver'),{target:{value:driverId}});fireEvent.change(screen.getByLabelText('Vehicle'),{target:{value:vehicleId}});
  fireEvent.click(screen.getByRole('button',{name:'Confirm assignment'}));
  await screen.findByText(/no usable capacity record/);
  expect(screen.queryByText('Assignment rejected. Review driver, vehicle and run constraints.')).not.toBeInTheDocument();client.clear();
 });
});
