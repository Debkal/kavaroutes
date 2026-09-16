import {useRef,useState} from 'react';
import {useQuery} from '@tanstack/react-query';
import type {createCloudApi} from '../cloud-api';
import type {RouteView} from '@kavaroutes/api-contracts/client-route-proposals';
import {DevelopmentApiError} from '@kavaroutes/api-contracts/private-development-transport';
type Api=ReturnType<typeof createCloudApi>;
export function CloudRouteReview({api,day,enabled}:{api:Api;day:string;enabled:boolean}){
 const snapshot=useQuery({queryKey:['private-cloud','dispatch-route-shifts',day],queryFn:()=>api.dispatchSnapshot(day),enabled,retry:false,refetchInterval:5000});
 const [selected,setSelected]=useState('');
 const shifts=snapshot.data?.value.resources.filter(r=>r.kind==='driver-shift')??[];
 return <section aria-label="Driver route proposals"><h2>Driver route proposals</h2>
  <p>Review future-stop order. The server rechecks policy, current work and safety constraints on approval.</p>
  {snapshot.isError&&<p role="alert">Shift list unavailable. Refresh before reviewing proposals.</p>}
  <label>Recorded shift <select value={selected} onChange={e=>setSelected(e.target.value)}><option value="">Choose shift</option>{shifts.map((s,i)=><option key={s.reference} value={s.reference.slice('driver-shift:'.length)}>Shift {i+1} · version {s.version}</option>)}</select></label>
  {selected&&shifts.some(s=>s.reference===`driver-shift:${selected}`)&&<Review key={`${day}:${selected}`} api={api} shift={selected} enabled={enabled&&!snapshot.isError}/>}
 </section>;
}
function Review({api,shift,enabled}:{api:Api;shift:string;enabled:boolean}){
 const view=useQuery({queryKey:['private-cloud','dispatch-route-review',shift],queryFn:()=>api.routeProposals(shift),enabled,retry:false,refetchInterval:5000});
 const pending=useRef<Parameters<Api['decideRoute']>[0]|null>(null),flight=useRef(false);
 const [message,setMessage]=useState(''),[busy,setBusy]=useState(false);
 const decide=async(proposalId:string,decision:'APPROVED'|'REJECTED')=>{
  if(flight.current||!enabled||!view.data||view.isError)return;
  if(!pending.current){const proposal=view.data.value.proposals.find(p=>p.proposalId===proposalId);if(!proposal)return;if(!window.confirm(`${decision==='APPROVED'?'Approve':'Reject'} this proposed stop order?`))return;pending.current={proposalId,decision,expectedRunVersion:view.data.value.runVersion,expectedTag:proposal.expectedTag,key:`route-decision-${crypto.randomUUID()}`};}
  flight.current=true;setBusy(true);
  try{const receipt=(await api.decideRoute(pending.current)).value;pending.current=null;setMessage(`Server decision: ${receipt.state}.`);await view.refetch();}
  catch(error){if(error instanceof DevelopmentApiError&&[400,401,403,404,409,410,412,422].includes(error.status)){pending.current=null;setMessage('Decision rejected. Refresh and review the current route.');await view.refetch();}else setMessage('Outcome unknown. Recover the original decision here, or use Command recovery after reloading.');}
  finally{flight.current=false;setBusy(false);}
 };
 const data=view.data?.value;
 const nodeLabel=(id:string,v:RouteView)=>{const n=v.nodes.find(n=>n.nodeId===id);return n?`${n.kind} · stop ${v.nodes.indexOf(n)+1}${n.locked?' · locked':''}`:'Historical stop';};
 return <section aria-label="Selected shift route review">
  <button onClick={()=>void view.refetch()} disabled={busy}>Refresh proposals</button>
  {view.isError&&<p role="alert">Route review unavailable. Planning facts may be missing or this shift may no longer be active. No approval inferred.</p>}
  {data&&<><h3>Current route · version {data.runVersion}</h3><ol>{data.nodes.map(n=><li key={n.nodeId}>{nodeLabel(n.nodeId,data)}</li>)}</ol>
   {!data.proposals.length&&<p>No saved proposals.</p>}
   {data.proposals.map((p,i)=><article key={p.proposalId}><h4>Proposal {i+1} · {p.state}</h4><ol>{p.nodeOrder.map(id=><li key={id}>{nodeLabel(id,data)}</li>)}</ol>
    {p.state==='PENDING_DISPATCH_APPROVAL'&&<><button disabled={busy||!!pending.current||view.isError} onClick={()=>void decide(p.proposalId,'APPROVED')}>Approve proposal {i+1}</button><button disabled={busy||!!pending.current||view.isError} onClick={()=>void decide(p.proposalId,'REJECTED')}>Reject proposal {i+1}</button></>}
   </article>)}
  </>}
  {pending.current&&<button disabled={busy} onClick={()=>void decide(pending.current!.proposalId,pending.current!.decision)}>Recover original decision</button>}
  <p role="status">{message}</p>
 </section>;
}
