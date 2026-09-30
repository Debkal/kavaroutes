import {selectPonyPersona} from './pony-fixtures.js';
import {createApiTransport,type DevelopmentFetch} from './http-transport.js';
export {DevelopmentApiError} from './http-transport.js';
export type {DevelopmentFetch,DevelopmentResponse} from './http-transport.js';
export type DevelopmentPersona='dispatcher'|'driver'|'facility'|'billing'|'policy_override';
/** Isolated development fixtures only. Live clients use authenticated transports. */
export function createPrivateDevelopmentTransport(options:{baseUrl:string;persona:DevelopmentPersona;ponyCompany?:string;
 fetch:DevelopmentFetch;timeoutMs?:number;browserSameOrigin?:boolean;anonymous?:boolean;driverSession?:()=>string|null}){
 const base=new URL(options.baseUrl);
 const loopback=base.protocol==='http:'&&base.hostname==='127.0.0.1'&&Boolean(base.port);
 const edge=options.browserSameOrigin===true&&base.protocol==='https:'&&!base.port;
 if((!loopback&&!edge)||base.pathname!=='/'||base.username||base.password||base.search||base.hash)throw new Error('PRIVATE_DEVELOPMENT_LOOPBACK_REQUIRED');
 if(!['dispatcher','driver','facility','billing','policy_override'].includes(options.persona))throw new Error('INVALID_DEVELOPMENT_PERSONA');
 if(options.anonymous&&(options.persona!=='driver'||options.driverSession))throw new Error('INVALID_ANONYMOUS_TRANSPORT');
 const token=options.ponyCompany===undefined?`principal_${options.persona}`:selectPonyPersona(options.ponyCompany,options.persona).token;
 return createApiTransport({...options,credentials:edge?'same-origin':'omit',headers:()=>{
  const session=options.driverSession?.();
  if(options.driverSession&&(!session||!/^dvs_[A-Za-z0-9_-]{43}$/.test(session)))throw new Error('DRIVER_SESSION_REQUIRED');
  return options.anonymous?{}:{authorization:session?`DriverSession ${session}`:`Synthetic ${token}`};
 }});
}
