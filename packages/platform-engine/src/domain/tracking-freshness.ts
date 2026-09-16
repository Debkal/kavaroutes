/** Silence is observable; its cause is not. Neither a socket nor an old batch proves live GPS. */
export function assessTrackingFreshness(input:{
 now:number;startedAt:number;lifecycle:string;collectionStopped:boolean;
 lastCapturedAt:number|null;lastReceivedAt:number|null;
 stopReason?:'SAFETY'|'PRIVACY'|'DEVICE_PROBLEM'|'OTHER'|null;
}){
 const thresholdMs=60_000;
 const result=(status:string,reason:string,contactDriver:boolean)=>({status,reason,contactDriver,
  evaluatedAt:new Date(input.now).toISOString(),lastCapturedAt:input.lastCapturedAt===null?null:new Date(input.lastCapturedAt).toISOString(),
  lastReceivedAt:input.lastReceivedAt===null?null:new Date(input.lastReceivedAt).toISOString(),staleAfterSeconds:60 as const});
 if(input.lifecycle==='SHIFT_ENDED')return result('SHIFT_ENDED','ACCEPTED_SIGN_OFF',false);
 if(input.lifecycle!=='ACTIVE')return result('STATUS_UNAVAILABLE','SHIFT_REQUIRES_REVIEW',true);
 if(input.collectionStopped)return result('TRACKING_STOPPED',input.stopReason?`DRIVER_REPORTED_${input.stopReason}`:'STOP_RECORDED_REASON_UNAVAILABLE',true);
 if(input.lastCapturedAt===null||input.lastReceivedAt===null)return input.now-input.startedAt>thresholdMs
  ?result('NO_UPDATES','NO_RECENT_UPDATE_UNKNOWN_CAUSE',true):result('WAITING_FOR_FIRST_UPDATE','STARTUP_GRACE_PERIOD',false);
 if(input.now-input.lastCapturedAt>thresholdMs||input.now-input.lastReceivedAt>thresholdMs||input.lastCapturedAt>input.now+30_000||input.lastReceivedAt>input.now+30_000)
  return result('UPDATES_OVERDUE','NO_RECENT_UPDATE_UNKNOWN_CAUSE',true);
 return result('UPDATES_CURRENT','RECENT_SAMPLE_RECEIVED',false);
}
