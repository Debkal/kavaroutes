import type {BrowserCommandEnvelope} from '@kavaroutes/api-contracts/client-web';
import {DevelopmentApiError,type createPrivateDevelopmentTransport} from '@kavaroutes/api-contracts/private-development-transport';
type Transport=ReturnType<typeof createPrivateDevelopmentTransport>;
export type RecoverySummary={id:string;kind:BrowserCommandEnvelope['kind'];expired:boolean;acknowledged:boolean;outcome:'PENDING'|'ACCEPTED'|'REJECTED';code:string|null};
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const kinds=['CREATE_TRIP','CANCEL_TRIP','ASSIGN_RUN','DECIDE_ROUTE','OVERRIDE_RETURN'];
const prefix='/v1/organizations/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/browser-commands';
const obj=(v:unknown):Record<string,unknown>=>{if(!v||typeof v!=='object'||Array.isArray(v))throw new Error('INVALID_RECOVERY_RESPONSE');return v as Record<string,unknown>;};
const keys=(v:Record<string,unknown>,expected:string[])=>{if(Object.keys(v).sort().join()!==expected.sort().join())throw new Error('INVALID_RECOVERY_RESPONSE');};
function record(value:unknown){
 const v=obj(value);keys(v,['id','envelope','result','expired','acknowledged']);const envelope=obj(v.envelope);
 if(typeof v.id!=='string'||!uuid.test(v.id)||typeof v.expired!=='boolean'||typeof v.acknowledged!=='boolean'||!kinds.includes(String(envelope.kind)))throw new Error('INVALID_RECOVERY_RESPONSE');
 keys(envelope,envelope.kind==='CREATE_TRIP'?['kind','body']:envelope.kind==='OVERRIDE_RETURN'?['kind','body','resourceId']:['kind','body','resourceId','expectedTag']);obj(envelope.body);
 const result=v.result===null?null:obj(v.result);
 if(result){
  if(result.outcome==='ACCEPTED'){keys(result,['outcome','statusCode','body','etag']);obj(result.body);if(typeof result.statusCode!=='number'||![200,201].includes(result.statusCode)||result.etag!==null&&(typeof result.etag!=='string'||!/^"kr1\.[A-Za-z0-9_-]{32,64}"$/.test(result.etag)))throw new Error('INVALID_RECOVERY_RESPONSE');}
  else if(result.outcome==='REJECTED'){keys(result,['outcome','statusCode','code']);if(!Number.isInteger(result.statusCode)||Number(result.statusCode)<400||Number(result.statusCode)>499||typeof result.code!=='string'||!/^[A-Z][A-Z0-9_]{0,127}$/.test(result.code))throw new Error('INVALID_RECOVERY_RESPONSE');}
  else throw new Error('INVALID_RECOVERY_RESPONSE');
 }
 if(v.acknowledged&&!result)throw new Error('INVALID_RECOVERY_RESPONSE');
 const summary:RecoverySummary={id:v.id,kind:envelope.kind as RecoverySummary['kind'],expired:v.expired,acknowledged:v.acknowledged,outcome:result?.outcome as 'ACCEPTED'|'REJECTED'??'PENDING',code:result?.outcome==='REJECTED'?String(result.code):null};
 return {summary,envelope,result};
}
function canonical(v:unknown):string{if(Array.isArray(v))return '['+v.map(canonical).join(',')+']';if(v&&typeof v==='object')return '{'+Object.entries(v).sort(([a],[b])=>a.localeCompare(b)).map(([k,value])=>JSON.stringify(k)+':'+canonical(value)).join(',')+'}';return JSON.stringify(v);}
export async function recoveryIdentity(kind:string,key:string){
 const bytes=new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode('kavaroutes-browser-command-v1:'+kind+':'+key)));bytes[6]=(bytes[6]!&15)|64;bytes[8]=(bytes[8]!&63)|128;
 const hex=Array.from(bytes.slice(0,16),b=>b.toString(16).padStart(2,'0')).join('');return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}
export function createCloudCommandRecovery(transport:Transport){
 const command=async(action:'execute'|'acknowledge',id:string)=>{if(!uuid.test(id))throw new Error('INVALID_RECOVERY_ID');return transport.request(`${prefix}/${id}/${action}`,value=>{const r=record(value);if(r.summary.id!==id)throw new Error('INVALID_RECOVERY_ID');return r;},{body:{},idempotencyKey:`browser-${action}-${id}`});};
 return {
  async pending(signal?:AbortSignal){return transport.request(prefix+'/pending',value=>{const v=obj(value);keys(v,['command']);return v.command===null?null:record(v.command).summary;},undefined,signal);},
  async execute(id:string){return (await command('execute',id)).value.summary;},
  async acknowledge(id:string){return (await command('acknowledge',id)).value.summary;},
  async run<T>(envelope:BrowserCommandEnvelope,key:string,decode:(value:unknown)=>T){
   const id=await recoveryIdentity(envelope.kind,key);
   const prepared=await transport.request(prefix,value=>{const r=record(value);if(r.summary.id!==id||canonical(r.envelope)!==canonical(envelope))throw new Error('ORIGINAL_COMMAND_MISMATCH');return r;},{body:{id,envelope},idempotencyKey:`browser-prepare-${id}`});
   const completed=(await command('execute',id)).value;
   if(canonical(completed.envelope)!==canonical(envelope))throw new DevelopmentApiError(0,'OUTCOME_UNKNOWN');
   if(completed.result?.outcome==='REJECTED')throw new DevelopmentApiError(Number(completed.result.statusCode),String(completed.result.code));
   if(completed.result?.outcome!=='ACCEPTED')throw new DevelopmentApiError(0,'OUTCOME_UNKNOWN');
   // Acknowledgement is explicit after reviewing the result, never hidden here.
   try{return {value:decode(completed.result.body),etag:completed.result.etag as string|null,replayed:prepared.value.result!==null};}
   catch{throw new DevelopmentApiError(0,'OUTCOME_UNKNOWN');}
  }
 };
}
