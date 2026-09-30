import {queryOptions} from '@tanstack/react-query';
import type {createCloudApi} from './cloud-api';

type Api=ReturnType<typeof createCloudApi>;
// This deployed Dispatch composition uses one authenticated organization. All
// keys retain that boundary; sign-out clears the entire QueryClient context.
const scope=['private-cloud','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','dispatch'] as const;
export const dispatchKeys={
  board:(day:string)=>[...scope,'ASSIGNED_SERVICE_DELIVERY',day] as const,
  snapshot:(day:string)=>[...scope,'snapshot',day] as const,
  tracking:(day:string)=>[...scope,'tracking',day] as const,
  history:(day:string)=>[...scope,'history',day] as const,
  trace:(day:string,shift:string|null,client:string|null)=>[...scope,'full-trace',day,shift,client||null] as const,
};
export const dispatchQueries={
  board:(api:Api,day:string)=>queryOptions({queryKey:dispatchKeys.board(day),queryFn:({signal})=>api.board(day,signal),staleTime:15_000,retry:false}),
  snapshot:(api:Api,day:string)=>queryOptions({queryKey:dispatchKeys.snapshot(day),queryFn:({signal})=>api.dispatchSnapshot(day,signal),staleTime:30_000,retry:false}),
  tracking:(api:Api,day:string)=>queryOptions({queryKey:dispatchKeys.tracking(day),queryFn:()=>api.tracking(day),staleTime:10_000,retry:false}),
  history:(api:Api,day:string)=>queryOptions({queryKey:dispatchKeys.history(day),queryFn:()=>api.routeHistory(day),staleTime:30_000,retry:false}),
  trace:(api:Api,day:string,shift:string|null,client:string|null)=>queryOptions({queryKey:dispatchKeys.trace(day,shift,client),
    queryFn:()=>{if(!shift)throw new Error('SHIFT_REQUIRED');return api.fullTrace(day,shift,client||null);},staleTime:60_000,retry:false}),
};
export const boardPollingInterval=(live:string)=>live==='live'?30_000:5_000;
export const recoveryPollingInterval=(outcome:string|undefined|null)=>outcome==='PENDING'?2_000:30_000;
