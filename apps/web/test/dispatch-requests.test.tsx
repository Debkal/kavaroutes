import {it,expect,vi} from 'vitest';
import {act,render,screen,fireEvent} from '@testing-library/react';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {MemoryRouter} from 'react-router';
import {CloudBoard} from '../src/components/CloudBoard';
import {DispatchRouteHistory} from '../src/components/DispatchRouteHistory';
import {dispatchQueries} from '../src/dispatch-queries';
import type {createCloudApi} from '../src/cloud-api';

let connection:{status:(value:string)=>void;refresh:()=>Promise<void>}|undefined;
vi.mock('../src/cloud-live',()=>({connectCloudDispatch:vi.fn((options)=>{connection=options;options.status('live');return()=>{};})}));
vi.mock('../src/components/CloudRouteReview',()=>({CloudRouteReview:()=>null}));
vi.mock('../src/components/RouteStreetMap',()=>({RouteStreetMap:()=>null}));
const day='2026-09-25';
const client=()=>new QueryClient({defaultOptions:{queries:{retry:false,gcTime:0}}});

it('shares in-flight and cached full traces while separating client/date/shift scopes',async()=>{
  const cache=client(),fullTrace=vi.fn(async()=>({value:{points:[]}}));
  const api={fullTrace} as unknown as ReturnType<typeof createCloudApi>;
  await Promise.all([cache.fetchQuery(dispatchQueries.trace(api,day,'shift-a','')),cache.fetchQuery(dispatchQueries.trace(api,day,'shift-a',null))]);
  await cache.fetchQuery(dispatchQueries.trace(api,day,'shift-a',null));
  expect(fullTrace).toHaveBeenCalledTimes(1);
  await cache.fetchQuery(dispatchQueries.trace(api,day,'shift-a','client-a'));
  await cache.fetchQuery(dispatchQueries.trace(api,day,'shift-b',null));
  await cache.fetchQuery(dispatchQueries.trace(api,'2026-09-26','shift-a',null));
  expect(fullTrace).toHaveBeenCalledTimes(4);
  cache.clear();
});

it('uses one live connection with a 30-second safety refresh, then resumes 5-second fallback on disconnect',async()=>{
  vi.useFakeTimers();
  const cache=client(),board=vi.fn(async()=>({value:{serviceDate:day,runs:[],legs:[],drivers:[],vehicles:[]}}));
  try{
    render(<QueryClientProvider client={cache}><CloudBoard api={{board} as never} serviceDate={day} enabled/></QueryClientProvider>);
    await act(async()=>{await vi.advanceTimersByTimeAsync(1);});
    expect(board).toHaveBeenCalledTimes(1);
    await act(async()=>{await vi.advanceTimersByTimeAsync(29_000);});
    expect(board).toHaveBeenCalledTimes(1);
    await act(async()=>{await vi.advanceTimersByTimeAsync(1000);});
    expect(board).toHaveBeenCalledTimes(2);
    await act(async()=>{connection!.status('reconnecting');});
    await act(async()=>{await vi.advanceTimersByTimeAsync(5000);});
    expect(board).toHaveBeenCalledTimes(3);
    await act(async()=>{await connection!.refresh();});
    expect(board).toHaveBeenCalledTimes(4);
  }finally{cache.clear();vi.useRealTimers();}
});

it('refreshes empty history without requesting a nonexistent shift trace',async()=>{
  const cache=client(),fullTrace=vi.fn();
  const api={tracking:async()=>({value:{shifts:[]}}),board:async()=>({value:{legs:[]}}),routeHistory:async()=>({value:{events:[],tripClients:[]}}),fullTrace};
  render(<MemoryRouter><QueryClientProvider client={cache}><DispatchRouteHistory api={api as never} day={day} enabled/></QueryClientProvider></MemoryRouter>);
  await screen.findByText(/No completed shifts match/);
  fireEvent.click(screen.getByRole('button',{name:'Refresh history'}));
  await act(async()=>{});
  expect(fullTrace).not.toHaveBeenCalled();
  cache.clear();
});
