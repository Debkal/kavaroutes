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
 // One reviewer panel is rendered per recorded shift, so the landmark name carries the
 // shift: two panels with the same region label are indistinguishable to a screen reader
 // (and fail axe's landmark-unique rule).
 return <section aria-label={`Authorized return review for shift ${shift}`}><button onClick={()=>setSelected(true)} disabled={selected}>Open authorized return review</button>
 {selected&&<Review api={api} shift={shift}/>}</section>;
}

function Review({api,shift}:{api:Api;shift:string}){
 const [pending,setPending]=useState<Command|null>(null);
 const [message,setMessage]=useState(''),[busy,setBusy]=useState(false),flight=useRef(false);
 const [acknowledgeUnresolved,setAcknowledgeUnresolved]=useState(false);
 const view=useQuery({queryKey:['private-cloud','policy_override','return-review',shift],queryFn:()=>api.returnReview(shift),retry:false,refetchInterval:5000});
 const submit=async()=>{
  if(flight.current)return;let command=pending;
  if(!command){
   const v=view.data?.value;
   if(view.isError||v?.lifecycle!=='ACTIVE'||!v.exceptionCommandId)return;
   const emergency=v.closurePath==='EMERGENCY_STOP';
   if(emergency&&!acknowledgeUnresolved)return;
   if(!emergency&&v.returnMode!=='REQUIRED_WITH_AUDITED_OVERRIDE')return;
   if(!window.confirm(emergency
     ? 'Resolve the emergency stop and end this shift? Legs are not all complete, so the unresolved riders are recorded with your acknowledgement.'
     : 'Record review of this return exception and end the shift? Required vehicle checks and unresolved riders cannot be waived.'))return;
   try{
    command={...await returnReviewIdentity(shift,v.shiftGeneration,v.exceptionCommandId,v.resourceVersion),shiftGeneration:v.shiftGeneration,expectedVersion:v.resourceVersion,exceptionCommandId:v.exceptionCommandId,
      reason:'RETURN_EXCEPTION_REVIEWED',...(emergency?{emergencyStopResolution:true}:{})};
    setPending(command);
   }catch{setMessage('Secure request identity unavailable. No override submitted.');return;}
  }
  flight.current=true;setBusy(true);
  try{
   await api.overrideReturn(shift,command!);setPending(null);
   setMessage(command.emergencyStopResolution===true
     ? 'Server accepted the emergency resolution; shift ended with unresolved riders acknowledged and collection stopped.'
     : 'Server accepted audited override; shift ended and collection stopped.');
   await view.refetch();
  }
  catch(error){
   if(error instanceof DevelopmentApiError&&[400,401,403,404,409,410,412,422].includes(error.status)){
    setPending(null);setMessage('Override rejected. Refresh and review; no checklist or rider safety control was waived.');await view.refetch();
   }else setMessage('Outcome unknown. Recover this original request or reload the authoritative review. An unchanged version derives the same request identity.');
  }
  finally{flight.current=false;setBusy(false);}
 };
 const v=view.data?.value;
 const emergency=v?.closurePath==='EMERGENCY_STOP';
 const blocked=view.isError||!v?.exceptionCommandId||v.lifecycle!=='ACTIVE'||(emergency?!acknowledgeUnresolved:v.returnMode!=='REQUIRED_WITH_AUDITED_OVERRIDE');
 return <section>
  <p>Test identity: policy_override. This separate role is not a permission granted to ordinary dispatchers. No rider or GPS details are loaded.</p>
  <CloudCommandRecovery recovery={api.reviewerRecovery} enabled={!view.isError} reviewer/>
  {view.isError?<p role="alert">Authorized return review unavailable.</p>:null}
  {v?<p>This control closes shift <span>{shift}</span> only, on the board service date. Return policy: {v.returnMode}. Recorded exception: {v.returnResult??'None'}. Shift: {v.lifecycle}.</p>:null}
  {emergency&&v?.lifecycle==='ACTIVE'?<p role="status">This shift was emergency-stopped with riders unresolved. Resolving it ends the shift and records that acknowledgement in the audit trail.</p>:null}
  {v?.lifecycle==='SHIFT_ENDED'?<p>Server confirms this shift has ended. No further override is allowed.</p>:null}
  {!pending&&v&&v.lifecycle==='ACTIVE'&&!v.exceptionCommandId?<p role="status">This shift has no recorded exception yet, so there is nothing to resolve. The driver records sign-off, or an emergency stop is recorded, first.</p>:null}
  {!pending&&v&&v.lifecycle==='ACTIVE'&&v.exceptionCommandId&&!emergency&&v.returnMode!=='REQUIRED_WITH_AUDITED_OVERRIDE'?<p role="status">This shift does not require an audited override ({v.returnMode}), so the control stays disabled.</p>:null}
  <label><input type="checkbox" checked={acknowledgeUnresolved} disabled={busy} onChange={event=>setAcknowledgeUnresolved(event.target.checked)}/> I acknowledge unresolved riders for an emergency resolution</label>
  <button disabled={busy||(!pending&&blocked)} onClick={()=>void submit()}>{pending?'Recover original return override':emergency?'Resolve emergency stop and end shift':'Record audited return override'}</button>
  <p>If the override is refused although the shift qualifies, an earlier reviewer command is still unacknowledged: acknowledge it in Command recovery above, then submit once.</p>
  <p role="status">{message}</p>
 </section>;
}
