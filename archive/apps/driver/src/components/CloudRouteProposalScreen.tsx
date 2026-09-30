import {useEffect,useMemo,useRef,useState} from 'react';
import {Text} from 'react-native';
import type {RouteView} from '@kavaroutes/api-contracts/client-route-proposals';
import {DevelopmentApiError} from '@kavaroutes/api-contracts/private-development-transport';
import {createCloudDriverApi} from '../cloud-server';
import {openCloudRouteStore} from '../nativeActions';
import {useWorkflow} from '../workflow-context';
import {FeasibilityScreen} from './FeasibilityScreen';
import {PrimaryButton} from './PrimaryButton';
import {StatusCard} from './StatusCard';

export function CloudRouteProposalScreen(){
 const w=useWorkflow(),api=useMemo(()=>createCloudDriverApi(),[]),shift=w.state.shiftReference;
 const [view,setView]=useState<RouteView|null>(null),[order,setOrder]=useState<string[]>([]),[message,setMessage]=useState('Loading saved route…');
 const [pending,setPending]=useState(false),flight=useRef(false),writes=useRef(Promise.resolve());
 const binding=useRef(shift);binding.current=shift;
 const valid=(v:RouteView)=>v.shiftId===shift&&v.shiftGeneration===w.state.shiftGeneration&&v.policyDigest===w.state.effectivePolicy?.canonicalDigest;
 const load=async()=>{
  if(!shift)return;const store=await openCloudRouteStore();
  const response=(await api.getRouteProposals(shift)).value;
  if(binding.current!==shift||!valid(response))throw new Error('SHIFT_CHANGED');
  const saved=await store.draft(shift);
  const next=saved&&valid(saved.view)&&saved.view.runVersion===response.runVersion&&saved.view.factsVersion===response.factsVersion?saved.order:response.nodes.map(n=>n.nodeId);
  await store.save(response,next);setView(response);setOrder(next);
  setPending((await store.commands(shift)).some(c=>c.state==='PENDING'));
  setMessage('Server route recovered. Edits are proposals until an approval is committed.');
 };
 useEffect(()=>{let active=true;setView(null);setOrder([]);
  void (async()=>{if(!shift)return;const store=await openCloudRouteStore(),saved=await store.draft(shift);
   if(active&&saved&&valid(saved.view)){setView(saved.view);setOrder(saved.order);setMessage('Saved offline draft. Server acceptance is not implied.');}
   if(active)setPending((await store.commands(shift)).some(c=>c.state==='PENDING'));
   if(active)await load();
  })().catch(()=>{if(active)setMessage('Live route unavailable. A saved draft is not an accepted route. Retry when connected.');});
  return()=>{active=false;binding.current=undefined;};
 },[shift,w.state.shiftGeneration]);
 const move=async(index:number,offset:number)=>{
  if(!view||pending||flight.current)return;const next=[...order],target=index+offset;
  const locked=view.nodes.reduce((last,n,i)=>n.locked?i:last,-1);
  if(index<=locked||target<=locked||target<0||target>=next.length)return;
  [next[index],next[target]]=[next[target]!,next[index]!];setOrder(next);
  writes.current=writes.current.then(async()=>{await(await openCloudRouteStore()).save(view,next);});
  try{await writes.current;}catch{setMessage('Protected draft save failed. Reopen before submitting.');}
 };
 const submit=async()=>{
  if(!shift||!view||flight.current||w.state.moving)return;flight.current=true;
  try{await writes.current;const store=await openCloudRouteStore();const command=await store.prepare(view,order);setPending(true);
   try{const receipt=(await api.submitRouteProposal(shift,command.request,command.command_key)).value;await store.record(command,receipt);
    setPending(false);await load();await w.syncCloudActions();setMessage(`Server decision: ${receipt.state.replaceAll('_',' ')}. Only committed approval changes the itinerary.`);
   }catch(cause){if(cause instanceof DevelopmentApiError&&[400,401,403,404,409,410,412,413,422].includes(cause.status)){await store.record(command,null);setPending(false);setMessage('Server rejected the proposal. Recover the latest route before editing.');}else throw cause;}
  }catch{setMessage('No acceptance confirmed. Recover the original saved proposal; do not create a replacement.');}finally{flight.current=false;}
 };
 if(w.state.moving||!shift)return <FeasibilityScreen title="Route review unavailable" summary="Park safely and recover the active shift first."/>;
 const locked=view?.nodes.reduce((last,n,i)=>n.locked?i:last,-1)??-1;
 return <FeasibilityScreen title="Review future route" summary="Synthetic private-cloud prototype. Reordering never edits rider details or bypasses route constraints.">
  <StatusCard title="Route status" status={message}/>
  <PrimaryButton label="Recover server route" onPress={async()=>{try{await load();}catch{setMessage('Server route unavailable. No approval inferred.');}}}/>
  {view?<><Text>{view.mode.replaceAll('_',' ')} · route version {view.runVersion}</Text>
   {order.map((id,index)=>{const n=view.nodes.find(n=>n.nodeId===id);if(!n)return null;const leg=w.itinerary?.legs.find(l=>l.tripLegId===n.tripLegId);
    return <StatusCard key={id} title={`${index+1}. ${n.kind.replaceAll('_',' ')}`} status={index<=locked?'Locked':'Future stop'}>
     <Text>{leg?.riderLabel??(n.kind==='BREAK'?'Scheduled break':n.kind==='RETURN'?'Vehicle return':'Assigned client')}</Text>
     <PrimaryButton label={`Move stop ${index+1} earlier`} disabled={pending||view.mode==='DISABLED'||index<=locked+1} onPress={()=>move(index,-1)}/>
     <PrimaryButton label={`Move stop ${index+1} later`} disabled={pending||view.mode==='DISABLED'||index<=locked||index===order.length-1} onPress={()=>move(index,1)}/>
    </StatusCard>;
   })}
   <PrimaryButton label={pending?'Recover original proposal':'Submit route proposal'} disabled={!pending&&view.mode==='DISABLED'} onPress={submit}/>
   {view.proposals.map((p,i)=><StatusCard key={p.proposalId} title={`Proposal ${i+1}`} status={p.state.replaceAll('_',' ')}/>)}
  </>:null}
 </FeasibilityScreen>;
}
