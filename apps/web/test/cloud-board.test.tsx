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
  fireEvent.click(await screen.findByRole('button',{name:'Assign driver'}));
  fireEvent.change(screen.getByLabelText('Driver'),{target:{value:driverId}});
  fireEvent.change(screen.getByLabelText('Vehicle'),{target:{value:vehicleId}});
  fireEvent.click(screen.getByRole('button',{name:'Assign driver and vehicle'}));
  await screen.findByText(/Outcome unknown/);
  expect(screen.queryByText('Assignment confirmed by the server. Driver itinerary updated.')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button',{name:'Retry original assignment'}));
  await screen.findByText('Assignment confirmed by the server. Driver itinerary updated.');
  expect(commands[0]).toEqual(commands[1]);expect(assign).toHaveBeenCalledTimes(2);client.clear();
 });
 it('clears an earlier accepted assignment only after the board confirms the same driver and vehicle',async()=>{
  const current=fixture();current.runs[0]={...current.runs[0]!,assignmentId,driverId,vehicleId,version:2};
  const id='55555555-5555-4555-8555-555555555555';
  const recovery={pendingAssignment:vi.fn(async()=>({id,kind:'ASSIGN_RUN',outcome:'ACCEPTED',acknowledged:false,expired:false,code:null,
    command:{runId,expectedVersion:1,expectedTag,driverId,vehicleId,key:''},receipt:{assignmentId,runId,version:2,serviceDate:current.serviceDate}})),
    acknowledge:vi.fn(async()=>({acknowledged:true}))};
  const client=mount({board:async()=>({value:structuredClone(current)}),recovery,assign:vi.fn()});
  await screen.findByText('Earlier assignment confirmed by the server. Driver and vehicle are assigned.');
  expect(recovery.acknowledge).toHaveBeenCalledWith(id);
  expect(screen.queryByRole('button',{name:'Check earlier assignment'})).not.toBeInTheDocument();client.clear();
 });
 it('acknowledges a newly accepted assignment after the board confirms it',async()=>{
  const current=fixture();
  const recovery={pendingAssignment:vi.fn(async()=>null),acknowledge:vi.fn(async()=>({acknowledged:true}))};
  const assign=vi.fn(async()=>{current.runs[0]={...current.runs[0]!,assignmentId,driverId,vehicleId,version:2};return {value:{assignmentId,runId,version:2,serviceDate:current.serviceDate}};});
  const client=mount({board:async()=>({value:structuredClone(current)}),recovery,assign});
  vi.spyOn(window,'confirm').mockReturnValue(true);
  fireEvent.click(await screen.findByRole('button',{name:'Assign driver'}));
  fireEvent.change(screen.getByLabelText('Driver'),{target:{value:driverId}});
  fireEvent.change(screen.getByLabelText('Vehicle'),{target:{value:vehicleId}});
  fireEvent.click(screen.getByRole('button',{name:'Assign driver and vehicle'}));
  await screen.findByText('Assignment confirmed by the server. Driver itinerary updated.');
  expect(recovery.acknowledge).toHaveBeenCalledOnce();
  expect(assign).toHaveBeenCalledOnce();client.clear();
 });
 it('resolves an accepted prior assignment inline when a new request meets the unacknowledged-command block',async()=>{
  const current=fixture(),id='55555555-5555-4555-8555-555555555555';
  let earlierAccepted=false;
  const recovery={pendingAssignment:vi.fn(async()=>earlierAccepted?{id,kind:'ASSIGN_RUN',outcome:'ACCEPTED',acknowledged:false,expired:false,code:null,
    command:{runId,expectedVersion:1,expectedTag,driverId,vehicleId,key:''},receipt:{assignmentId,runId,version:2,serviceDate:current.serviceDate}}:null),
    acknowledge:vi.fn(async()=>({acknowledged:true}))};
  const assign=vi.fn(async()=>{earlierAccepted=true;current.runs[0]={...current.runs[0]!,assignmentId,driverId,vehicleId,version:2};
    throw new DevelopmentApiError(409,'PERSISTENCE_IDEMPOTENCY_IN_PROGRESS','req_wp007_00028542');});
  const client=mount({board:async()=>({value:structuredClone(current)}),recovery,assign});
  vi.spyOn(window,'confirm').mockReturnValue(true);
  await waitFor(()=>expect(recovery.pendingAssignment).toHaveBeenCalledOnce());
  fireEvent.click(await screen.findByRole('button',{name:'Assign driver'}));
  fireEvent.change(screen.getByLabelText('Driver'),{target:{value:driverId}});
  fireEvent.change(screen.getByLabelText('Vehicle'),{target:{value:vehicleId}});
  fireEvent.click(screen.getByRole('button',{name:'Assign driver and vehicle'}));
  await screen.findByText('Earlier assignment confirmed by the server. Driver and vehicle are assigned.');
  expect(recovery.acknowledge).toHaveBeenCalledWith(id);
  expect(assign).toHaveBeenCalledOnce();client.clear();
 });
 it('checks the authoritative receipt after a lost assignment response',async()=>{
  const current=fixture(),id='55555555-5555-4555-8555-555555555555';
  let accepted=false;
  const recovery={pendingAssignment:vi.fn(async()=>accepted?{id,kind:'ASSIGN_RUN',outcome:'ACCEPTED',acknowledged:false,expired:false,code:null,
    command:{runId,expectedVersion:1,expectedTag,driverId,vehicleId,key:''},receipt:{assignmentId,runId,version:2,serviceDate:current.serviceDate}}:null),
    acknowledge:vi.fn(async()=>({acknowledged:true}))};
  const assign=vi.fn(async()=>{accepted=true;current.runs[0]={...current.runs[0]!,assignmentId,driverId,vehicleId,version:2};throw new DevelopmentApiError(0,'OUTCOME_UNKNOWN');});
  const client=mount({board:async()=>({value:structuredClone(current)}),recovery,assign});
  vi.spyOn(window,'confirm').mockReturnValue(true);
  await waitFor(()=>expect(recovery.pendingAssignment).toHaveBeenCalledOnce());
  fireEvent.click(await screen.findByRole('button',{name:'Assign driver'}));
  fireEvent.change(screen.getByLabelText('Driver'),{target:{value:driverId}});
  fireEvent.change(screen.getByLabelText('Vehicle'),{target:{value:vehicleId}});
  fireEvent.click(screen.getByRole('button',{name:'Assign driver and vehicle'}));
  await screen.findByText('Earlier assignment confirmed by the server. Driver and vehicle are assigned.');
  expect(recovery.acknowledge).toHaveBeenCalledWith(id);
  expect(assign).toHaveBeenCalledOnce();client.clear();
 });
 it('does not clear an accepted receipt if the board shows a different assignment',async()=>{
  const current=fixture(),id='55555555-5555-4555-8555-555555555555';
  const recovery={pendingAssignment:vi.fn(async()=>({id,kind:'ASSIGN_RUN',outcome:'ACCEPTED',acknowledged:false,expired:false,code:null,
    command:{runId,expectedVersion:1,expectedTag,driverId,vehicleId,key:''},receipt:{assignmentId,runId,version:2,serviceDate:current.serviceDate}})),
    acknowledge:vi.fn()};
  const client=mount({board:async()=>({value:structuredClone(current)}),recovery});
  await screen.findByRole('button',{name:'Check earlier assignment'});
  expect(recovery.acknowledge).not.toHaveBeenCalled();client.clear();
 });
 it('refreshes a conflict without applying optimistic assignment',async()=>{
  const board=vi.fn(async()=>({value:fixture()}));
  const client=mount({board,assign:async()=>{throw new DevelopmentApiError(412,'VERSION_CONFLICT');}});
  vi.spyOn(window,'confirm').mockReturnValue(true);
  fireEvent.click(await screen.findByRole('button',{name:'Assign driver'}));
  fireEvent.change(screen.getByLabelText('Driver'),{target:{value:driverId}});fireEvent.change(screen.getByLabelText('Vehicle'),{target:{value:vehicleId}});
  fireEvent.click(screen.getByRole('button',{name:'Assign driver and vehicle'}));
 await screen.findByText('Conflict. Refresh and review the current records before retrying.');
 await waitFor(()=>expect(board.mock.calls.length).toBeGreaterThan(1));
 expect(screen.queryByRole('button',{name:'Retry original assignment'})).not.toBeInTheDocument();client.clear();
});
 it('names the constraint the backend refused instead of one generic rejection',async()=>{
  const board=vi.fn(async()=>({value:fixture()}));
  const client=mount({board,assign:async()=>{throw new DevelopmentApiError(409,'PERSISTENCE_FEASIBILITY');}});
  vi.spyOn(window,'confirm').mockReturnValue(true);
  fireEvent.click(await screen.findByRole('button',{name:'Assign driver'}));
  fireEvent.change(screen.getByLabelText('Driver'),{target:{value:driverId}});fireEvent.change(screen.getByLabelText('Vehicle'),{target:{value:vehicleId}});
  fireEvent.click(screen.getByRole('button',{name:'Assign driver and vehicle'}));
  await screen.findByText(/no usable capacity record/);
  expect(screen.queryByText('Assignment rejected. Review driver, vehicle and run constraints.')).not.toBeInTheDocument();client.clear();
 });
});
