import {useCallback,useEffect,useRef,useState} from 'react';

export type ScreenAwakeState='off'|'active'|'released'|'unavailable';

/** A screen wake lock is a foreground aid. Browsers release it when the page is
 * hidden, and it does not grant background geolocation permission. */
export function useDriverScreenAwake(shiftActive:boolean){
  const [enabled,setEnabled]=useState(false);
  const [state,setState]=useState<ScreenAwakeState>('off');
  const lockRef=useRef<WakeLockSentinel|null>(null);
  const requestingRef=useRef<number|null>(null);
  const generation=useRef(0);
  const activeRef=useRef(shiftActive);activeRef.current=shiftActive;
  const enabledRef=useRef(enabled);enabledRef.current=enabled;
  const supported=typeof navigator!=='undefined'&&'wakeLock' in navigator&&typeof navigator.wakeLock?.request==='function';

  const release=useCallback(()=>{
    generation.current++;
    const lock=lockRef.current;lockRef.current=null;
    if(lock)void lock.release().catch(()=>{});
  },[]);
  const acquire=useCallback(async()=>{
    if(!activeRef.current||!enabledRef.current||document.visibilityState!=='visible')return;
    if(!('wakeLock' in navigator)||typeof navigator.wakeLock?.request!=='function'){
      setState('unavailable');return;
    }
    if((lockRef.current&&!lockRef.current.released)||requestingRef.current===generation.current)return;
    const request=generation.current;
    requestingRef.current=request;
    try{
      const lock=await navigator.wakeLock.request('screen');
      if(request!==generation.current||!activeRef.current||!enabledRef.current||document.visibilityState!=='visible'){
        void lock.release().catch(()=>{});return;
      }
      lockRef.current=lock;setState('active');
      lock.addEventListener('release',()=>{
        if(lockRef.current!==lock)return;
        lockRef.current=null;
        if(enabledRef.current&&activeRef.current)setState('released');
      });
    }catch{if(request===generation.current)setState('unavailable');}
    finally{if(requestingRef.current===request)requestingRef.current=null;}
  },[]);
  const turnOn=useCallback(async()=>{
    if(!activeRef.current)return;
    enabledRef.current=true;setEnabled(true);setState('released');
    await acquire();
  },[acquire]);
  const turnOff=useCallback(()=>{
    enabledRef.current=false;setEnabled(false);release();setState('off');
  },[release]);
  useEffect(()=>{
    if(!shiftActive){turnOff();return;}
    const onVisibility=()=>{
      if(document.visibilityState==='visible')void acquire();
      else{release();if(enabledRef.current)setState('released');}
    };
    document.addEventListener('visibilitychange',onVisibility);
    return()=>{document.removeEventListener('visibilitychange',onVisibility);release();};
  },[shiftActive,acquire,release,turnOff]);

  return {supported,enabled,state,turnOn,turnOff};
}
