import type {PrincipalVerifier,SyntheticPrincipal} from '@kavaroutes/api-contracts/security';
import {createMembershipPrincipal} from '@kavaroutes/api-contracts/security';
import {ProtocolError} from '@kavaroutes/api-contracts/protocol';
import {createBrowserCredentials} from './browser-credentials.js';

interface SessionIdentity {
  organizationId:string;principalId:string;role:'DRIVER'|'DISPATCHER';driverId:string|null;
  authorizationGeneration:number;expiresAt:string;
  scopeKinds:readonly string[];capabilityGrants:readonly string[];
}
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

export function createBrowserRealtimeRevalidator(verifier:PrincipalVerifier) {
  return async(request:{method:string;headers:Readonly<Record<string,unknown>>},original:SyntheticPrincipal)=>{
    if(original.kind!=='BROWSER_USER'||request.method!=='GET'||!verifier.verifyRequest)return false;
    const current=await verifier.verifyRequest(request);
    if(!current||current.kind!==original.kind||current.id!==original.id||current.organizationId!==original.organizationId||current.subjectId!==original.subjectId)return false;
    for(const field of ['capabilities','purposes','branchScopes','fleetScopes'] as const){
      if([...current[field]].sort().join(',')!==[...original[field]].sort().join(','))return false;
    }
    return true;
  };
}

/** Database role mapping, never a role/capability submitted by the browser.
 * Branch/fleet scopes come only from persisted grants, so a membership without
 * grants holds no scoped authority. Policy administration and return overrides
 * require their own explicit capability grants and are not implied by a role.
 */
export function createBrowserPrincipalVerifier(options:{origin:string;signingKey:Buffer;
  resolve:(organizationId:string,tokenHash:string,csrfHash:string)=>Promise<SessionIdentity|null>;
}):PrincipalVerifier {
  const credentials=createBrowserCredentials(options);
  return Object.freeze({
    async verify(){return null;}, // Never interpret a synthetic/Bearer header.
    async verifyRequest(request:Parameters<NonNullable<PrincipalVerifier['verifyRequest']>>[0]){
      let credential;
      try {
        if(request.headers.authorization!==undefined)return null;
        const safe=['GET','HEAD'].includes(request.method);
        if(!safe&&!['POST','PUT','PATCH','DELETE'].includes(request.method))return null;
        if(safe&&request.headers.origin===undefined) {
          if(request.headers['sec-fetch-site']!=='same-origin')return null;
        } else credentials.assertSameOrigin(request.headers);
        const recovered=credentials.recover(request.headers.cookie);
        if(!recovered)return null;
        if(!safe) {
          const csrf=request.headers['x-kr-csrf'];
          if(typeof csrf!=='string')return null;
          const submitted=credentials.read(request.headers.cookie,csrf);
          if(submitted?.csrfHash!==recovered.csrfHash)return null;
        }
        credential=recovered;
      } catch{return null;}
      let row;
      try{row=await options.resolve(credential.organizationId,credential.tokenHash,credential.csrfHash);}
      catch{throw new ProtocolError(503,'SESSION_UNAVAILABLE','session unavailable');}
      if(!row||row.organizationId!==credential.organizationId||!uuid.test(row.principalId)||
        !Number.isSafeInteger(row.authorizationGeneration)||row.authorizationGeneration<1||
        !Number.isFinite(Date.parse(row.expiresAt))||Date.parse(row.expiresAt)<=Date.now()||
        !['DRIVER','DISPATCHER'].includes(row.role))return null;
      if(row.role==='DRIVER'&&(typeof row.driverId!=='string'||!uuid.test(row.driverId)))return null;
      if(row.role==='DISPATCHER'&&row.driverId!==null)return null;
      const principal=createMembershipPrincipal({...row,capabilityGrants:row.capabilityGrants,scopeKinds:row.scopeKinds});
      return Object.freeze(principal);
    },
  });
}
