import {afterEach, expect, test, vi} from 'vitest';
import {nativeDriverAvailable, nativeDriverCommand} from '../src/native-driver-bridge';

afterEach(() => vi.unstubAllGlobals());

function driverWindow(pathname='/driver') {
  const sent:string[]=[];
  const target=Object.assign(new EventTarget(), {
    location:{origin:'https://driver.kavaroutes.com',pathname},
    setTimeout:window.setTimeout.bind(window),
    clearTimeout:window.clearTimeout.bind(window),
    ReactNativeWebView:{postMessage:(message:string)=>sent.push(message)},
  });
  vi.stubGlobal('window',target);
  return {target,sent};
}

test('only the production Driver page enables native tracking',async()=>{
  driverWindow('/dispatch');
  expect(nativeDriverAvailable()).toBe(false);
  await expect(nativeDriverCommand({type:'PREPARE'})).rejects.toThrow('NATIVE_DRIVER_UNAVAILABLE');
});

test('native replies are matched to the initiating command',async()=>{
  const {target,sent}=driverWindow();
  expect(nativeDriverAvailable()).toBe(true);
  const result=nativeDriverCommand({type:'START',token:'dvs_'+ 'a'.repeat(43),organizationId:'dddddddd-dddd-4ddd-8ddd-dddddddddddd',driverId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',shiftReference:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',shiftGeneration:'cccccccc-cccc-4ccc-8ccc-cccccccccccc'});
  expect(sent).toHaveLength(1);
  const command=JSON.parse(sent[0]!) as {requestId:string;type:string};
  expect(command.type).toBe('START');
  let settled=false;
  void result.then(()=>{settled=true;});
  target.dispatchEvent(new CustomEvent('kavaroutes-native-reply',{detail:{requestId:crypto.randomUUID(),state:'stopped',message:'wrong command'}}));
  await Promise.resolve();
  expect(settled).toBe(false);
  target.dispatchEvent(new CustomEvent('kavaroutes-native-reply',{detail:{requestId:command.requestId,state:'active',message:'Background location on'}}));
  await expect(result).resolves.toEqual({state:'active',message:'Background location on'});
});
