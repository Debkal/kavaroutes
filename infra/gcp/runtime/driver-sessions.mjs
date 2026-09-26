import {createHash,randomBytes} from 'node:crypto';
import {readFileSync,writeFileSync,renameSync} from 'node:fs';
import {companyBranchScope,companyFleetScope,roleCapabilities,rolePurposes} from '@kavaroutes/api-contracts/security';

const tokenPattern=/^DriverSession (dvs_[A-Za-z0-9_-]{43})$/;
const ttlMs=36*60*60*1000;
const digest=token=>createHash('sha256').update(token).digest('hex');

/** Driver tokens are stored only as hashes in a private VM file, so an API restart
 * does not interrupt a live trip. Credential versions still revoke old tokens. */
export function createDriverSessions({synthetic,credentialVersion,allowSyntheticDriver=false,now=()=>Date.now(),sessionFile}){
  const saved=sessionFile?(()=>{try{return JSON.parse(readFileSync(sessionFile,'utf8'));}catch(error){if(error.code==='ENOENT')return {version:1,sessions:[]};throw error;}})():{version:1,sessions:[]};
  if(saved.version!==1||!Array.isArray(saved.sessions))throw new Error('DRIVER_SESSIONS_INVALID');
  const sessions=new Map(saved.sessions.filter(row=>typeof row.key==='string').map(row=>[row.key,row.session]));
  const persist=()=>{
    if(!sessionFile)return;
    const temporary=`${sessionFile}.${randomBytes(8).toString('hex')}.tmp`;
    writeFileSync(temporary,JSON.stringify({version:1,sessions:[...sessions].map(([key,session])=>({key,session}))}),{mode:0o600,flag:'wx'});
    renameSync(temporary,sessionFile);
  };
  const purge=()=>{for(const [key,row] of sessions)if(row.expiresAt<=now())sessions.delete(key);};
  return Object.freeze({
    issue(organizationId,state){
      if(state.status!=='ACTIVE')throw new Error('DRIVER_CREDENTIAL_NOT_ACTIVE');
      purge();
      const token=`dvs_${randomBytes(32).toString('base64url')}`;
      sessions.set(digest(token),{organizationId,driverId:state.driverId,version:state.version,expiresAt:now()+ttlMs});
      persist();
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
      if(session.expiresAt<=now()){sessions.delete(key);persist();return null;}
      let current;
      try{current=await credentialVersion(session.organizationId,session.driverId);}
      catch{return null;}
      if(!current||current.status!=='ACTIVE'||current.version!==session.version){sessions.delete(key);persist();return null;}
      return Object.freeze({id:session.driverId,kind:'SYNTHETIC_DEVICE',organizationId:session.organizationId,
        subjectId:session.driverId,capabilities:new Set(roleCapabilities.DRIVER),purposes:new Set(rolePurposes.DRIVER),
        branchScopes:new Set([companyBranchScope(session.organizationId)]),fleetScopes:new Set([companyFleetScope(session.organizationId)])});
    },
  });
}
