import type {DriverClosureRequest,DriverClosureView,DriverSyntheticLocationRequest,DriverPrecheckReceipt} from '@kavaroutes/api-contracts/client-web';
import {DevelopmentApiError} from '@kavaroutes/api-contracts/private-development-transport';
import type {SyntheticWorkflow} from '@kavaroutes/driver-core';
import type {createCloudDriverApi} from './cloud-server';
import type {createCloudFinishStore} from './cloud-finish-store';
export async function recoverCloudFinish(api:ReturnType<typeof createCloudDriverApi>,store:ReturnType<typeof createCloudFinishStore>,shift:string,stop:()=>Promise<unknown>){
 const commands=await store.list(shift);
 // Emergency stop has no network prerequisite and takes precedence over queued location.
 const emergency=commands.find(c=>c.kind==='EMERGENCY'&&c.state==='PENDING');if(emergency)await stop();
 for(const c of [...commands].sort((a,b)=>Number(b.kind==='EMERGENCY')-Number(a.kind==='EMERGENCY'))){
  if(c.state!=='PENDING')continue;
  try{
   const receipt=c.kind==='LOCATION'?(await api.submitSyntheticLocations(shift,c.request as DriverSyntheticLocationRequest,c.key)).value:(await api.submitClosure(shift,c.request as DriverClosureRequest,c.key)).value;
   await store.record(c,receipt);if('collectionStopped' in receipt&&receipt.collectionStopped)await stop();
  }catch(error){if(error instanceof DevelopmentApiError&&[400,401,403,404,409,410,412,413,415,422].includes(error.status)){await store.record(c,null);continue;}throw error;}
 }
 const view=(await api.getClosure(shift)).value;if(view.collectionStopped||view.lifecycle==='SHIFT_ENDED')await stop();return view;
}
export function adoptCloudFinish(state:SyntheticWorkflow,view:DriverClosureView):SyntheticWorkflow{
 if(state.shiftReference!==view.shiftReference||state.shiftGeneration!==view.shiftGeneration)throw new Error('CLOSURE_SHIFT_BINDING_CHANGED');
 const ended=view.lifecycle==='SHIFT_ENDED',stopped=view.collectionStopped;
 const post=view.postcheck;
 return {...state,authoritativeVersion:view.resourceVersion,...(ended?{phase:'SHIFT_ENDED' as const,tracking:'STOPPED' as const,moving:false}:stopped?{phase:'EMERGENCY_STOPPED' as const,tracking:'EMERGENCY_STOPPED' as const,moving:false}:post?{phase:'SIGNOFF_PENDING' as const}:{}),
  ...(view.lastEvent==='RETURN_EXCEPTION'&&!ended&&!stopped?{phase:'RETURN_LOCATION_EXCEPTION' as const}:{}),
  ...(post?{postCheckComplete:post.inspectionOutcome==='COMPLETED',postInspectionOutcome:post.inspectionOutcome as DriverPrecheckReceipt['inspectionOutcome'],endOdometerOutcome:post.odometerOutcome as DriverPrecheckReceipt['odometerOutcome'],...(post.odometer===null?{}:{endOdometer:post.odometer})}:{}),
  lastReceipt:ended?'Server accepted sign-off. Location collection stopped.':stopped?'Location collection stopped. Dispatch must resolve the shift.':view.returnResult?`Server return result: ${view.returnResult}.`:state.lastReceipt};
}
