import {DevelopmentApiError} from '@kavaroutes/api-contracts/private-development-transport';
import {recoverCloudFinish,adoptCloudFinish} from '../src/cloud-finish';
import {createSyntheticWorkflow} from '../../../packages/driver-core/src/workflow';
const shift='50000000-0000-4000-8000-000000000001',generation='50000000-0000-4000-8000-000000000002';
const view:any={shiftReference:shift,shiftGeneration:generation,resourceVersion:3,lifecycle:'ACTIVE',collectionStopped:false,postcheck:null,lastEvent:null,returnResult:null};
const command:any={shift,kind:'CLOSE',key:'original-close-key',request:{commandId:'original-command',shiftGeneration:generation},state:'PENDING'};
test('lost sign-off response keeps original request and stops collection after exact replay',async()=>{
 const store:any={list:jest.fn(async()=>[command]),record:jest.fn()},stop=jest.fn();
 const api:any={submitClosure:jest.fn().mockRejectedValueOnce(new DevelopmentApiError(0,'OUTCOME_UNKNOWN')).mockResolvedValue({value:{collectionStopped:true}}),getClosure:jest.fn(async()=>({value:{...view,lifecycle:'SHIFT_ENDED',collectionStopped:true}}))};
 await expect(recoverCloudFinish(api,store,shift,stop)).rejects.toMatchObject({code:'OUTCOME_UNKNOWN'});
 expect(store.record).not.toHaveBeenCalled();expect(stop).not.toHaveBeenCalled();
 const recovered=await recoverCloudFinish(api,store,shift,stop);
 expect(api.submitClosure.mock.calls).toEqual([[shift,command.request,command.key],[shift,command.request,command.key]]);
 expect(stop).toHaveBeenCalled();expect(recovered.lifecycle).toBe('SHIFT_ENDED');
});
test('pending emergency stops locally before network and before an older queued location batch',async()=>{
 const order:string[]=[];const emergency={...command,kind:'EMERGENCY'};
 const store:any={list:async()=>[{...command,kind:'LOCATION'},emergency],record:jest.fn()};
 const api:any={submitClosure:jest.fn(async()=>{order.push('network');throw new DevelopmentApiError(0,'BACKEND_UNAVAILABLE');}),submitSyntheticLocations:jest.fn()};
 await expect(recoverCloudFinish(api,store,shift,async()=>{order.push('stop');})).rejects.toMatchObject({code:'BACKEND_UNAVAILABLE'});
 expect(order).toEqual(['stop','network']);expect(api.submitSyntheticLocations).not.toHaveBeenCalled();expect(store.record).not.toHaveBeenCalled();
});
test('definitive rejection is recorded, while neutral return review never becomes sign-off',async()=>{
 const store:any={list:async()=>[command],record:jest.fn()},stop=jest.fn();
 const api:any={submitClosure:async()=>{throw new DevelopmentApiError(409,'STALE_VERSION');},getClosure:async()=>({value:{...view,lastEvent:'RETURN_EXCEPTION',returnResult:'OUTSIDE'}})};
 const result=await recoverCloudFinish(api,store,shift,stop);
 expect(store.record).toHaveBeenCalledWith(command,null);expect(stop).not.toHaveBeenCalled();
 const state:any={...createSyntheticWorkflow(),shiftReference:shift,shiftGeneration:generation,phase:'SIGNOFF_PENDING',tracking:'TRACKING'};
 expect(adoptCloudFinish(state,result)).toMatchObject({phase:'RETURN_LOCATION_EXCEPTION',tracking:'TRACKING'});
 expect(adoptCloudFinish(state,{...result,lifecycle:'SHIFT_ENDED',collectionStopped:true})).toMatchObject({phase:'SHIFT_ENDED',tracking:'STOPPED'});
 expect(()=>adoptCloudFinish(state,{...result,shiftGeneration:'wrong'})).toThrow('CLOSURE_SHIFT_BINDING_CHANGED');
});
