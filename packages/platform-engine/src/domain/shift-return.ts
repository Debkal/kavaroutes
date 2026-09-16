export type ReturnResult='NOT_REQUIRED'|'PASS'|'OUTSIDE'|'STALE'|'INACCURATE'|'UNAVAILABLE';
/** Synthetic fixture adapter only; cannot receive or classify a real person's GPS. */
export function evaluateSyntheticReturn(mode:string,sample:{fixture:string;capturedAt:number}|null,maximumAgeSeconds:number|null,now:number):ReturnResult{
 if(mode==='DISABLED')return 'NOT_REQUIRED';
 if(!['ADVISORY','REQUIRED_WITH_AUDITED_OVERRIDE'].includes(mode))throw new Error('PINNED_RETURN_POLICY_INVALID');
 if(!sample||maximumAgeSeconds===null)return 'UNAVAILABLE';
 if(!Number.isFinite(sample.capturedAt)||sample.capturedAt>now+30000||now-sample.capturedAt>maximumAgeSeconds*1000)return 'STALE';
 if(sample.fixture==='INACCURATE')return 'INACCURATE';
 if(sample.fixture==='OUTSIDE_RETURN')return 'OUTSIDE';
 return sample.fixture==='AT_RETURN'?'PASS':'UNAVAILABLE';
}
