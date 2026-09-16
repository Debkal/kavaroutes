import {useRef,useState} from 'react';
import {useQuery} from '@tanstack/react-query';
import {DevelopmentApiError} from '@kavaroutes/api-contracts/private-development-transport';
import type {createCloudApi} from '../cloud-api';
import {CloudCommandRecovery} from './CloudCommandRecovery';
type Api=ReturnType<typeof createCloudApi>;
type Command=Parameters<Api['overrideReturn']>[1];
export async function returnReviewIdentity(shift:string,generation:string,exception:string,version:number){
 const bytes=new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(`kr.synthetic.return-override.v1:${shift}:${generation}:${exception}:${version}`)));
 bytes[6]=(bytes[6]!&15)|64;bytes[8]=(bytes[8]!&63)|128;
 const hex=Array.from(bytes.slice(0,16),b=>b.toString(16).padStart(2,'0')).join('');
 const commandId=`${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
 return {commandId,key:`return-override-${commandId}`};
}
export function CloudReturnReview({api,shift}:{api:Api;shift:string}){
 const [selected,setSelected]=useState(false);
 return <section aria-label="Authorized return review"><button onClick={()=>setSelected(true)} disabled={selected}>Open synthetic authorized return reviewer</button>
 {selected&&<Review api={api} shift={shift}/>}</section>;
}
function Review({api,shift}:{api:Api;shift:string}){
 const [pending,setPending]=useState<Command|null>(null);
 const [message,setMessage]=useState(''),[busy,setBusy]=useState(false),flight=useRef(false);
 const view=useQuery({queryKey:['private-cloud','policy_override','return-review',shift],queryFn:()=>api.returnReview(shift),retry:false,refetchInterval:5000});
 const submit=async()=>{
  if(flight.current)return;let command=pending;
  if(!command){const v=view.data?.value;if(view.isError||v?.lifecycle!=='ACTIVE'||v.returnMode!=='REQUIRED_WITH_AUDITED_OVERRIDE'||!v.exceptionCommandId)return;
   if(!window.confirm('As the synthetic authorized reviewer, record review of this neutral return exception and end the shift? Required vehicle checks and unresolved riders cannot be waived.'))return;
   try{command={...await returnReviewIdentity(shift,v.shiftGeneration,v.exceptionCommandId,v.resourceVersion),shiftGeneration:v.shiftGeneration,expectedVersion:v.resourceVersion,exceptionCommandId:v.exceptionCommandId,reason:'RETURN_EXCEPTION_REVIEWED'};setPending(command);}catch{setMessage('Secure request identity unavailable. No override submitted.');return;}
  }
  flight.current=true;setBusy(true);
  try{await api.overrideReturn(shift,command);setPending(null);setMessage('Server accepted audited override; shift ended and collection stopped.');await view.refetch();}
  catch(error){if(error instanceof DevelopmentApiError&&[400,401,403,404,409,410,412,422].includes(error.status)){setPending(null);setMessage('Override rejected. Refresh and review; no checklist or rider safety control was waived.');await view.refetch();}else setMessage('Outcome unknown. Recover this original request or reload the authoritative review. An unchanged version derives the same request identity.');}
  finally{flight.current=false;setBusy(false);}
 };
 const v=view.data?.value;
 return <section><p>Test identity: policy_override. This separate role is not a permission granted to ordinary dispatchers. No rider or GPS details are loaded.</p>
 <CloudCommandRecovery recovery={api.reviewerRecovery} enabled={!view.isError} reviewer/>
 {view.isError&&<p role="alert">Authorized return review unavailable.</p>}
 {v&&<p>Return policy: {v.returnMode}. Recorded exception: {v.returnResult??'None'}. Shift: {v.lifecycle}.</p>}
 {v?.lifecycle==='SHIFT_ENDED'&&<p>Server confirms this shift has ended. No further override is allowed.</p>}
 <button disabled={busy||(!pending&&(view.isError||!v?.exceptionCommandId||v.lifecycle!=='ACTIVE'||v.returnMode!=='REQUIRED_WITH_AUDITED_OVERRIDE'))} onClick={()=>void submit()}>{pending?'Recover original return override':'Record audited return override'}</button>
 <p role="status">{message}</p></section>;
}
