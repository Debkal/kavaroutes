import {afterEach,expect,it,vi} from 'vitest';
import {act,renderHook} from '@testing-library/react';
import {useDriverScreenAwake} from '../src/use-driver-screen-awake';

afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();});

it('releases the screen lock for Maps and reacquires it when Driver is visible again',async()=>{
  const locks:{released:boolean;release:ReturnType<typeof vi.fn>;addEventListener:ReturnType<typeof vi.fn>}[]=[];
  const request=vi.fn(async()=>{
    const lock={released:false,release:vi.fn(async()=>{lock.released=true;}),addEventListener:vi.fn()};
    locks.push(lock);return lock;
  });
  vi.stubGlobal('navigator',{...navigator,wakeLock:{request}});
  const visibility=vi.spyOn(document,'visibilityState','get').mockReturnValue('visible');
  const hook=renderHook(({active}:{active:boolean})=>useDriverScreenAwake(active),{initialProps:{active:true}});
  await act(async()=>{await hook.result.current.turnOn();});
  expect(request).toHaveBeenCalledTimes(1);
  expect(hook.result.current.state).toBe('active');
  visibility.mockReturnValue('hidden');
  await act(async()=>{document.dispatchEvent(new Event('visibilitychange'));});
  expect(locks[0].release).toHaveBeenCalledTimes(1);
  expect(hook.result.current.state).toBe('released');
  visibility.mockReturnValue('visible');
  await act(async()=>{document.dispatchEvent(new Event('visibilitychange'));});
  expect(request).toHaveBeenCalledTimes(2);
  hook.rerender({active:false});
  expect(locks[1].release).toHaveBeenCalledTimes(1);
  expect(hook.result.current.enabled).toBe(false);
  hook.unmount();
});
