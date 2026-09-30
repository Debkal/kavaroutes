import {DevelopmentApiError,createApiTransport,type DevelopmentFetch} from '@kavaroutes/api-contracts/http-transport';

export type BusinessContext={organizationId:string;principalId:string;capabilities:string[];csrf:string|null;mode:'business'|'test'};
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
let context:BusinessContext|null=null;
export function setBusinessContext(value:BusinessContext|null){
 if(value&&(!uuid.test(value.organizationId)||!uuid.test(value.principalId)||!Array.isArray(value.capabilities)||
  value.capabilities.some(capability=>typeof capability!=='string')||!['business','test'].includes(value.mode)||
  (value.mode==='business'&&(typeof value.csrf!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(value.csrf)))))throw Error('INVALID_BUSINESS_CONTEXT');
 context=value;
}
export function businessContext(){if(!context)throw Error('BUSINESS_SIGN_IN_REQUIRED');return context;}
export async function loadBusinessContext(fetcher=fetch){
 const response=await fetcher('/auth/workspace',{credentials:'same-origin',redirect:'error',cache:'no-store',signal:AbortSignal.timeout(15000)});
 if(response.status===401){setBusinessContext(null);return null;}
 if(!response.ok)throw new DevelopmentApiError(response.status,'BUSINESS_SESSION_UNAVAILABLE');
 const value=await response.json() as BusinessContext;setBusinessContext(value);return value;
}
export function createBusinessTransport(baseUrl:string,fetcher:DevelopmentFetch,organizationId:string){
 if(!uuid.test(organizationId))throw Error('INVALID_BUSINESS_ID');
 return createApiTransport({baseUrl,fetch:fetcher,credentials:'same-origin',headers:()=>{
  const session=businessContext();
  if(session.organizationId!==organizationId)throw Error('BUSINESS_SESSION_CHANGED');
  return {'x-kr-business-id':organizationId,'x-kr-request':'business',...(session.csrf?{'x-kr-csrf':session.csrf}:{})};
 }});
}
export const businessQueryScope=()=>['business',businessContext().organizationId,businessContext().principalId] as const;
