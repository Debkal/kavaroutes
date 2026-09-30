import {it,expect,vi,afterEach} from 'vitest';
import {webcrypto} from 'node:crypto';
import {render,screen,fireEvent,waitFor} from '@testing-library/react';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {createPrivateDevelopmentTransport} from '@kavaroutes/api-contracts/private-development-transport';
import {createCloudCommandRecovery} from '../src/cloud-command-recovery';
import {CloudCommandRecovery} from '../src/components/CloudCommandRecovery';
const envelope={kind:'CANCEL_TRIP' as const,resourceId:'11111111-1111-4111-8111-111111111111',expectedTag:'"kr1.'+'A'.repeat(43)+'"',body:{reasonCode:'SYNTHETIC_REQUESTER_CANCELLED' as const}};
it('decodes an accepted assignment for safe board reconciliation',async()=>{
 const runId='11111111-1111-4111-8111-111111111111',assignmentId='44444444-4444-4444-8444-444444444444';
 const stored={id:'55555555-5555-4555-8555-555555555555',expired:false,acknowledged:false,
  envelope:{kind:'ASSIGN_RUN',resourceId:runId,expectedTag:'"kr1.'+'A'.repeat(43)+'"',body:{expectedVersion:1,driverId:'22222222-2222-4222-8222-222222222222',vehicleId:'33333333-3333-4333-8333-333333333333'}},
  result:{outcome:'ACCEPTED',statusCode:200,etag:null,body:{assignmentId,runId,version:2,serviceDate:'2026-09-25'}}};
 const transport={request:vi.fn(async(_path:string,decode:(value:unknown)=>unknown)=>({value:decode({command:stored})}))};
 const recovery=createCloudCommandRecovery(transport as any,"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
 expect(await recovery.pendingAssignment()).toMatchObject({id:stored.id,outcome:'ACCEPTED',receipt:{assignmentId,runId,version:2,serviceDate:'2026-09-25'}});
 expect(transport.request).toHaveBeenCalledOnce();
});
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();});
it('reopens an accepted unknown-outcome command without replacing or automatically acknowledging it',async()=>{
 vi.stubGlobal('crypto',webcrypto);vi.spyOn(window,'confirm').mockReturnValue(true);
 let stored:any=null,lost=true,effects=0;const requests:string[]=[];
 const fetcher=vi.fn(async(url:string,init:any)=>{
  requests.push(url);let body:any;
  if(url.endsWith('/pending'))body={command:stored?.acknowledged?null:stored};
  else if(url.endsWith('/execute')){if(!stored.result){effects++;stored.result={outcome:'ACCEPTED',statusCode:200,etag:null,body:{saved:true}};}if(lost){lost=false;throw new Error('lost response');}body=stored;}
  else if(url.endsWith('/acknowledge')){stored.acknowledged=true;body=stored;}
  else{const request=JSON.parse(init.body);stored??={...request,result:null,expired:false,acknowledged:false};body=stored;}
  return {status:200,headers:{get:()=>null},json:async()=>structuredClone(body)};
 });
 const api=()=>createCloudCommandRecovery(createPrivateDevelopmentTransport({baseUrl:'http://127.0.0.1:4311',persona:'dispatcher',fetch:fetcher}),"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
 await expect(api().run(envelope,'original-key',v=>v)).rejects.toMatchObject({code:'OUTCOME_UNKNOWN'});
 const original=stored.id,reopened=api();expect((await reopened.pending()).value).toMatchObject({id:original,outcome:'ACCEPTED'});expect(effects).toBe(1);expect(requests.filter(url=>url.endsWith('/acknowledge'))).toHaveLength(0);
 const cache=new QueryClient({defaultOptions:{queries:{retry:false,gcTime:0}}});const mounted=render(<QueryClientProvider client={cache}><CloudCommandRecovery recovery={reopened} enabled/></QueryClientProvider>);
 await screen.findByText('CANCEL TRIP · ACCEPTED');fireEvent.click(screen.getByText('Acknowledge reviewed result'));await screen.findByText('No requests need review.');expect(effects).toBe(1);expect(stored.id).toBe(original);
 mounted.unmount();cache.clear();
});
it('pending command execution needs confirmation and expired commands cannot be replaced in the panel',async()=>{
 vi.spyOn(window,'confirm').mockReturnValue(false);
 const value={id:'11111111-1111-4111-8111-111111111111',kind:'ASSIGN_RUN' as const,expired:false,acknowledged:false,outcome:'PENDING' as const,code:null};
 const recovery={pending:vi.fn(async()=>({value})),execute:vi.fn(),acknowledge:vi.fn(),run:vi.fn()};
 const cache=new QueryClient({defaultOptions:{queries:{retry:false,gcTime:0}}});const mounted=render(<QueryClientProvider client={cache}><CloudCommandRecovery recovery={recovery as any} enabled/></QueryClientProvider>);
 fireEvent.click(await screen.findByText('Recover original command'));expect(recovery.execute).not.toHaveBeenCalled();
 recovery.pending.mockResolvedValue({value:{...value,expired:true}});fireEvent.click(screen.getByText('Refresh command recovery'));await waitFor(()=>expect(screen.queryByText('Recover original command')).not.toBeInTheDocument());await screen.findByText(/Original command expired/);expect(recovery.acknowledge).not.toHaveBeenCalled();mounted.unmount();cache.clear();
});
