import {useRef,useState} from 'react';
import {useQuery,useQueryClient} from '@tanstack/react-query';
import type {createCloudCommandRecovery} from '../cloud-command-recovery';
export function CloudCommandRecovery({recovery,enabled,reviewer=false}:{recovery:ReturnType<typeof createCloudCommandRecovery>;enabled:boolean;reviewer?:boolean}){
 const cache=useQueryClient(),flight=useRef(false),[busy,setBusy]=useState(false),[message,setMessage]=useState('');
 const command=useQuery({queryKey:['private-cloud','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',reviewer?'policy_override':'dispatcher','command-recovery'],queryFn:({signal})=>recovery.pending(signal),enabled,retry:false,refetchInterval:2000});
 const current=!enabled||command.isError?null:command.data?.value;
 const act=async(acknowledge:boolean)=>{
  if(flight.current||!current||!enabled)return;
  if(!acknowledge&&!window.confirm(`Recover the original ${current.kind.replaceAll('_',' ').toLowerCase()} request? Its original version and authorization will be checked.`))return;
  flight.current=true;setBusy(true);setMessage('Checking the original server command…');
  try{const result=await (acknowledge?recovery.acknowledge(current.id):recovery.execute(current.id));setMessage(acknowledge?'Result acknowledged. You may continue.':result.outcome==='ACCEPTED'?'Server accepted the original command. Review refreshed records, then acknowledge.':result.outcome==='REJECTED'?`Server rejected the original command: ${result.code}. Review before continuing.`:'Command remains unresolved.');await cache.invalidateQueries({queryKey:['private-cloud']});}
  catch{setMessage('Recovery unavailable or outcome unknown. The original command remains on the server; refresh to recover it.');await command.refetch();}
  finally{flight.current=false;setBusy(false);}
 };
 return <section aria-label={reviewer?'Authorized reviewer command recovery':'Dispatcher command recovery'}><h2>Command recovery</h2>
 <p>Original requests are retained on the server. No browser storage is used. Review and acknowledge a result before starting another command.</p>
 {!enabled?<p>Recovery requires an authorized session.</p>:command.isError?<p role="alert">Command recovery unavailable. Refresh before issuing commands.</p>:command.isPending?<p role="status">Checking for an unresolved command…</p>:current?<>
 <p>{current.kind.replaceAll('_',' ')} · {current.outcome}{current.code?` · ${current.code}`:''}</p>
 {current.expired&&current.outcome==='PENDING'?<p role="alert">Original command expired. Operator review is required; no replacement is submitted.</p>:current.outcome==='PENDING'?<button disabled={busy||!enabled} onClick={()=>void act(false)}>Recover original command</button>:<button disabled={busy||!enabled} onClick={()=>void act(true)}>Acknowledge reviewed result</button>}
 </>:<p>No unacknowledged command.</p>}
 <button disabled={busy||!enabled} onClick={()=>void command.refetch()}>Refresh command recovery</button><p role="status">{message}</p></section>;
}
