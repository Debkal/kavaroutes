import {createHash,randomBytes} from 'node:crypto';
import {companyBranchScope,companyFleetScope,roleCapabilities,rolePurposes} from '@kavaroutes/api-contracts/security';

const tokenPattern=/^DriverSession (dvs_[A-Za-z0-9_-]{43})$/;
const ttlMs=12*60*60*1000;
const digest=token=>createHash('sha256').update(token).digest('hex');

/** Process-local sessions for the private live-trip runtime. Password resets and
 * re-verification invalidate older sessions through the persisted credential version.
 * A runtime restart asks drivers to sign in again; no token is stored in the browser. */
export function createDriverSessions({synthetic,credentialVersion,allowSyntheticDriver=false,now=()=>Date.now()}){
  const sessions=new Map();
  const purge=()=>{for(const [key,row] of sessions)if(row.expiresAt<=now())sessions.delete(key);};
  return Object.freeze({
    issue(organizationId,state){
      if(state.status!=='ACTIVE')throw new Error('DRIVER_CREDENTIAL_NOT_ACTIVE');
      purge();
      const token=`dvs_${randomBytes(32).toString('base64url')}`;
      sessions.set(digest(token),{organizationId,driverId:state.driverId,version:state.version,expiresAt:now()+ttlMs});
      return token;
    },
    async verify(authorization){
      if(typeof authorization!=='string')return null;
      const match=tokenPattern.exec(authorization);
      if(!match){
        const principal=await synthetic.verify(authorization);
        // A shared prototype driver can never reach live driver resources.
        return principal?.kind==='SYNTHETIC_DEVICE'&&!allowSyntheticDriver?null:principal;
      }
      const key=digest(match[1]),session=sessions.get(key);
      if(!session)return null;
      if(session.expiresAt<=now()){sessions.delete(key);return null;}
      let current;
      try{current=await credentialVersion(session.organizationId,session.driverId);}
      catch{return null;}
      if(!current||current.status!=='ACTIVE'||current.version!==session.version){sessions.delete(key);return null;}
      return Object.freeze({id:session.driverId,kind:'SYNTHETIC_DEVICE',organizationId:session.organizationId,
        subjectId:session.driverId,capabilities:new Set(roleCapabilities.DRIVER),purposes:new Set(rolePurposes.DRIVER),
        branchScopes:new Set([companyBranchScope(session.organizationId)]),fleetScopes:new Set([companyFleetScope(session.organizationId)])});
    },
  });
}
