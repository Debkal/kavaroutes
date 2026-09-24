import {afterEach,expect,it,vi} from 'vitest';
import {act,renderHook} from '@testing-library/react';
import {useLocationSharing} from '../src/use-location-sharing';

afterEach(()=>{vi.useRealTimers();vi.restoreAllMocks();});

it('retries the exact location batch after an uncertain upload and clears the warning on success',async()=>{
  vi.useFakeTimers();
  const position={timestamp:Date.now(),coords:{latitude:41.8,longitude:-87.6,accuracy:10}} as GeolocationPosition;
  const geolocation={getCurrentPosition:vi.fn((success:(value:GeolocationPosition)=>void)=>success(position)),
    watchPosition:vi.fn(()=>1),clearWatch:vi.fn()};
  vi.stubGlobal('navigator',{...navigator,geolocation});
  vi.stubGlobal('crypto',{randomUUID:()=> '11111111-1111-4111-8111-111111111111'});
  const locationBatch=vi.fn().mockRejectedValueOnce(new Error('network uncertain')).mockResolvedValueOnce({});
  const api={locationBatch};
  const target={shiftReference:'22222222-2222-4222-8222-222222222222',shiftGeneration:'33333333-3333-4333-8333-333333333333',deviceId:'44444444-4444-4444-8444-444444444444'};
  const hook=renderHook(({active}:{active:boolean})=>useLocationSharing({target:active?target:null,api}),{initialProps:{active:false}});
  await act(async()=>{expect(await hook.result.current.requestSharing()).toBe(true);});
  hook.rerender({active:true});
  await act(async()=>{await vi.advanceTimersByTimeAsync(10_000);});
  expect(hook.result.current.deliveryError).toBe(true);
  await act(async()=>{await vi.advanceTimersByTimeAsync(10_000);});
  expect(locationBatch).toHaveBeenCalledTimes(2);
  expect(locationBatch.mock.calls[1]).toEqual(locationBatch.mock.calls[0]);
  expect(hook.result.current.deliveryError).toBe(false);
  hook.unmount();
  vi.unstubAllGlobals();
});
