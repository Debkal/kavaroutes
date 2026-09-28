import {lstat,readFile,writeFile,rename,mkdir,rmdir,stat,unlink} from 'node:fs/promises';
import {join} from 'node:path';
import {randomBytes,randomUUID,scrypt as scryptCallback} from 'node:crypto';
import {promisify} from 'node:util';

const defaultDirectory='/run/kavaroutes-driver-access';
const fail=(status,code)=>{throw Object.assign(new Error(code),{status,code});};
const scrypt=promisify(scryptCallback);
function linkedWorkspace(store,businessId){
  if(typeof businessId!=='string'||!/^[0-9a-f-]{36}$/i.test(businessId))fail(400,'INVALID_BUSINESS');
  const linked=store.get(`SELECT b.id,b.name,w.tenant_id FROM businesses b JOIN business_workspaces w ON w.business_id=b.id WHERE b.id=?`,businessId);
  if(!linked||!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(linked.tenant_id))fail(404,'BUSINESS_WORKSPACE_NOT_FOUND');
  return linked;
}
function validState(state){
  if(state.version!==1||!Array.isArray(state.codes)||!Array.isArray(state.devices)||!Array.isArray(state.driverTokens)||!Array.isArray(state.events))fail(500,'DRIVER_ACCESS_STATE_INVALID');
}
export async function driverAccessLog(store,businessId,{directory=defaultDirectory}={}){
  const linked=linkedWorkspace(store,businessId);
  const path=join(directory,'access.json');
  let info;try{info=await lstat(path);}catch(error){if(error.code==='ENOENT')return {businessId,businessName:linked.name,events:[]};throw error;}
  if(!info.isFile()||info.size>3_000_000||(info.mode&0o007))fail(500,'DRIVER_ACCESS_LOG_INVALID');
  const state=JSON.parse(await readFile(path,'utf8'));
  validState(state);
  const events=state.events.filter(row=>row.businessId===linked.tenant_id&&Number.isSafeInteger(row.at)&&typeof row.action==='string'&&typeof row.actor==='string'&&typeof row.target==='string').slice(-100).reverse().map(row=>({at:row.at,action:row.action,actor:row.actor,target:row.target}));
  return {businessId,businessName:linked.name,events};
}
export async function resetAllDriverAccess(store,businessId,actor,{directory=defaultDirectory}={}){
  const linked=linkedWorkspace(store,businessId);
  const path=join(directory,'access.json'),lockPath=join(directory,'access.lock');
  let locked=false;
  for(let i=0;i<50;i++){
    try{await mkdir(lockPath);locked=true;break;}
    catch(error){
      if(error.code!=='EEXIST')throw error;
      const age=Date.now()-(await stat(lockPath)).mtimeMs;
      if(age>30_000){await rmdir(lockPath).catch(()=>{});continue;}
      await new Promise(resolve=>setTimeout(resolve,25+i*5));
    }
  }
  if(!locked)fail(503,'DRIVER_ACCESS_STATE_BUSY');
  const temporary=join(directory,`.access.${randomBytes(8).toString('hex')}.tmp`);
  try{
    const info=await lstat(path);
    if(!info.isFile()||info.size>3_000_000||(info.mode&0o007))fail(500,'DRIVER_ACCESS_STATE_INVALID');
    const state=JSON.parse(await readFile(path,'utf8'));validState(state);
    const now=Date.now(),tenantId=linked.tenant_id;
    let disabledCodeCount=0,signedOutDeviceCount=0;
    for(const code of state.codes)if(code.businessId===tenantId&&code.enabled){code.enabled=false;code.updatedAt=now;disabledCodeCount++;}
    for(const device of state.devices)if(device.businessId===tenantId&&!device.revokedAt){device.revokedAt=now;signedOutDeviceCount++;}
    const password=randomBytes(12).toString('base64url'),salt=randomBytes(16).toString('hex');
    const hash=(await scrypt(password,salt,64,{N:16384,r:8,p:1,maxmem:32*1024*1024})).toString('hex');
    const code=`biz_${randomBytes(8).toString('base64url')}`;
    const row={id:randomUUID(),businessId:tenantId,code,kind:'SHARED',label:'Admin reset',enabled:true,uses:0,createdAt:now,updatedAt:now,salt,hash};
    state.codes.push(row);
    state.events.push({at:now,businessId:tenantId,action:'ACCESS_CODES_RESET_ALL',actor,target:row.id});
    if(state.events.length>5000)state.events.splice(0,state.events.length-5000);
    await writeFile(temporary,`${JSON.stringify(state,null,2)}\n`,{mode:0o640,flag:'wx'});
    await rename(temporary,path);
    store.audit(actor,'DRIVER_ACCESS_CODES_RESET_ALL',businessId);
    return {businessId,businessName:linked.name,code,password,disabledCodeCount,signedOutDeviceCount};
  }finally{await unlink(temporary).catch(()=>{});await rmdir(lockPath).catch(()=>{});}
}
