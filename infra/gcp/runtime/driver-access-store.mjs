import {readFile,writeFile,rename,mkdir,rmdir,stat,unlink} from 'node:fs/promises';
import {join} from 'node:path';
import {randomBytes,randomUUID,scrypt as scryptCallback,timingSafeEqual,createHmac,createHash} from 'node:crypto';
import {promisify} from 'node:util';

const scrypt=promisify(scryptCallback);
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const codePattern=/^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/;
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
export const driverAccessUuid=uuid;
export const driverAccessCodePattern=codePattern;
export function createDriverAccessStore(directory,{now=()=>Date.now()}={}){
  if(!directory)throw new Error('DRIVER_ACCESS_DIRECTORY_REQUIRED');
  const path=join(directory,'access.json'),lockPath=join(directory,'access.lock');
  const read=async()=>{
    const state=JSON.parse(await readFile(path,'utf8'));
    if(state.version!==1||!Array.isArray(state.codes)||!Array.isArray(state.devices)||!Array.isArray(state.events)||!Array.isArray(state.driverTokens))throw new Error('DRIVER_ACCESS_STATE_INVALID');
    return state;
  };
  const change=async updater=>{
    let locked=false;
    for(let i=0;i<50;i++){
      try{await mkdir(lockPath);locked=true;break;}
      catch(error){if(error.code!=='EEXIST')throw error;
        const age=now()-(await stat(lockPath)).mtimeMs;
        if(age>30_000){await rmdir(lockPath).catch(()=>{});continue;}
        await wait(25+i*5);
      }
    }
    if(!locked)throw new Error('DRIVER_ACCESS_STATE_BUSY');
    const temporary=join(directory,`.access.${randomBytes(8).toString('hex')}.tmp`);
    try{
      const state=await read(),result=await updater(state);
      await writeFile(temporary,`${JSON.stringify(state,null,2)}\n`,{mode:0o640,flag:'wx'});
      await rename(temporary,path);
      return result;
    }finally{await unlink(temporary).catch(()=>{});await rmdir(lockPath).catch(()=>{});}
  };
  const newPassword=()=>randomBytes(12).toString('base64url');
  const hashPassword=async password=>{
    const salt=randomBytes(16).toString('hex');
    return {salt,hash:(await scrypt(password,salt,64,{N:16384,r:8,p:1,maxmem:32*1024*1024})).toString('hex')};
  };
  const verifyPassword=async(row,password)=>{
    // Older issued passwords remain valid until their business rotates them.
    if(typeof password!=='string'||password.length<10||password.length>200)return false;
    const salt=row?.salt??'00000000000000000000000000000000',hash=row?.hash??'0'.repeat(128);
    const computed=await scrypt(password,salt,64,{N:16384,r:8,p:1,maxmem:32*1024*1024});
    return Boolean(row&&/^[0-9a-f]{128}$/i.test(hash)&&timingSafeEqual(computed,Buffer.from(hash,'hex')));
  };
  const sign=(hash,payload)=>createHmac('sha256',Buffer.from(hash,'hex')).update(payload).digest('base64url');
  const publicCode=row=>({id:row.id,businessId:row.businessId,code:row.code,kind:row.kind,label:row.label,enabled:row.enabled,uses:row.uses,createdAt:row.createdAt,updatedAt:row.updatedAt});
  const publicDevice=row=>({id:row.id,businessId:row.businessId,codeId:row.codeId,label:row.label,createdAt:row.createdAt,lastSeenAt:row.lastSeenAt,expiresAt:row.expiresAt,revokedAt:row.revokedAt});
  const audit=(state,businessId,action,actor,target)=>{
    state.events.push({at:now(),businessId,action,actor,target});
    if(state.events.length>5000)state.events.splice(0,state.events.length-5000);
  };
  const list=async businessId=>{
    const state=await read();return {codes:state.codes.filter(row=>row.businessId===businessId).map(publicCode),devices:state.devices.filter(row=>row.businessId===businessId&&row.expiresAt>now()-7*86400_000).map(publicDevice),events:state.events.filter(row=>row.businessId===businessId).slice(-100).reverse()};
  };
  const inspectionSettings=async businessId=>{
    if(!uuid.test(businessId))throw new Error('INVALID_BUSINESS_ID');
    const state=await read();
    return {precheckDefault:state.inspectionSettings?.[businessId]??'NO_ISSUE'};
  };
  const setInspectionSettings=async(businessId,precheckDefault,actor='business-command')=>{
    if(!uuid.test(businessId)||!['NO_ISSUE','MANUAL'].includes(precheckDefault))throw new Error('INVALID_INSPECTION_SETTINGS');
    return change(state=>{
      state.inspectionSettings??={};
      state.inspectionSettings[businessId]=precheckDefault;
      audit(state,businessId,'PRECHECK_DEFAULT_CHANGED',actor,precheckDefault);
      return {precheckDefault};
    });
  };
  const createCode=async(businessId,kind,label='',actor='business-command')=>{
    if(!uuid.test(businessId)||!['SHARED','ONE_DEVICE'].includes(kind)||typeof label!=='string'||label.length>80)throw new Error('INVALID_ACCESS_CODE');
    const password=newPassword(),hashed=await hashPassword(password);
    const code=`${kind==='SHARED'?'biz':'dev'}_${randomBytes(8).toString('base64url')}`;
    const row={id:randomUUID(),businessId,code,kind,label:label.trim(),enabled:true,uses:0,createdAt:now(),updatedAt:now(),...hashed};
    await change(state=>{if(state.codes.filter(item=>item.businessId===businessId&&item.enabled).length>=100)throw new Error('ACCESS_CODE_LIMIT');state.codes.push(row);audit(state,businessId,'ACCESS_CODE_CREATED',actor,row.id);return null;});
    return {...publicCode(row),password};
  };
  const resetCode=async(businessId,id,actor='business-command')=>{
    const password=newPassword(),hashed=await hashPassword(password);
    const row=await change(state=>{
      const code=state.codes.find(row=>row.businessId===businessId&&row.id===id&&row.enabled);
      if(!code)throw new Error('ACCESS_CODE_NOT_FOUND');
      Object.assign(code,hashed,{updatedAt:now(),uses:0});
      for(const device of state.devices)if(device.codeId===id&&device.businessId===businessId&&!device.revokedAt)device.revokedAt=now();
      audit(state,businessId,'ACCESS_CODE_RESET',actor,id);
      return publicCode(code);
    });
    return {...row,password};
  };
  const disableCode=async(businessId,id,actor='business-command')=>change(state=>{
    const code=state.codes.find(row=>row.businessId===businessId&&row.id===id);
    if(!code)throw new Error('ACCESS_CODE_NOT_FOUND');
    code.enabled=false;code.updatedAt=now();
    for(const device of state.devices)if(device.codeId===id&&device.businessId===businessId&&!device.revokedAt)device.revokedAt=now();
    audit(state,businessId,'ACCESS_CODE_DISABLED',actor,id);
    return publicCode(code);
  });
  const signOutDevice=async(businessId,id,actor='business-command')=>change(state=>{
    const device=state.devices.find(row=>row.businessId===businessId&&row.id===id);
    if(!device)throw new Error('ACCESS_DEVICE_NOT_FOUND');
    if(!device.revokedAt)device.revokedAt=now();
    audit(state,businessId,'ACCESS_DEVICE_SIGNED_OUT',actor,id);
    return publicDevice(device);
  });
  const touchDevice=async(businessId,id)=>change(state=>{
    const device=state.devices.find(row=>row.businessId===businessId&&row.id===id&&!row.revokedAt);
    if(device)device.lastSeenAt=now();
    return null;
  });
  const enroll=async(code,password,agent)=>{
    const current=(await read()).codes.find(row=>row.code===code&&row.enabled&&!(row.kind==='ONE_DEVICE'&&row.uses>=1));
    if(!await verifyPassword(current,password))return null;
    return change(state=>{
      const row=state.codes.find(row=>row.id===current.id&&row.enabled&&row.hash===current.hash&&!(row.kind==='ONE_DEVICE'&&row.uses>=1));
      if(!row)return null;
      state.devices=state.devices.filter(item=>(!item.revokedAt||item.revokedAt>now()-7*86400_000)&&item.expiresAt>now()-7*86400_000);
      if(state.devices.length>=5000)throw new Error('ACCESS_DEVICE_LIMIT');
      const device={id:randomUUID(),businessId:row.businessId,codeId:row.id,label:row.label||String(agent??'Driver device').slice(0,80),createdAt:now(),lastSeenAt:now(),expiresAt:now()+30*86400_000,revokedAt:null};
      row.uses++;row.updatedAt=now();state.devices.push(device);
      audit(state,row.businessId,'ACCESS_DEVICE_ENROLLED','driver-device',device.id);
      const payload=Buffer.from(JSON.stringify({businessId:row.businessId,codeId:row.id,deviceId:device.id,expires:device.expiresAt})).toString('base64url');
      return {businessId:row.businessId,device:publicDevice(device),token:`${payload}.${sign(row.hash,payload)}`};
    });
  };
  const resolve=async token=>{
    if(typeof token!=='string'||token.length>512)return null;
    const [payload,mac,extra]=token.split('.');if(extra||!payload||!mac||!/^[A-Za-z0-9_-]+$/.test(payload)||!/^[A-Za-z0-9_-]{43}$/.test(mac))return null;
    let claims;try{claims=JSON.parse(Buffer.from(payload,'base64url').toString('utf8'));}catch{return null;}
    if(!claims||!uuid.test(claims.businessId)||!uuid.test(claims.codeId)||!uuid.test(claims.deviceId)||!Number.isSafeInteger(claims.expires)||claims.expires<=now()||claims.expires>now()+30*86400_000)return null;
    const state=await read(),row=state.codes.find(code=>code.id===claims.codeId&&code.businessId===claims.businessId&&code.enabled),device=state.devices.find(device=>device.id===claims.deviceId&&device.businessId===claims.businessId&&device.codeId===claims.codeId);
    if(!row||!device||device.revokedAt||device.expiresAt!==claims.expires||!/^[0-9a-f]{128}$/i.test(row.hash??''))return null;
    const actual=Buffer.from(mac,'base64url'),expected=Buffer.from(sign(row.hash,payload),'base64url');
    return actual.length===expected.length&&timingSafeEqual(actual,expected)?{businessId:row.businessId,deviceId:device.id,codeId:row.id}:null;
  };
  const bindDriverToken=async(businessId,deviceId,token)=>{
    if(!/^dvs_[A-Za-z0-9_-]{43}$/.test(token))throw new Error('DRIVER_TOKEN_INVALID');
    return change(state=>{
      const device=state.devices.find(row=>row.businessId===businessId&&row.id===deviceId&&!row.revokedAt&&row.expiresAt>now());
      if(!device)throw new Error('ACCESS_DEVICE_NOT_FOUND');
      const hash=createHash('sha256').update(token).digest('hex');
      state.driverTokens=state.driverTokens.filter(row=>row.createdAt>now()-36*60*60*1000&&row.hash!==hash);
      state.driverTokens.push({hash,businessId,deviceId,createdAt:now()});
      return true;
    });
  };
  const driverTokenAccess=async token=>{
    if(!/^dvs_[A-Za-z0-9_-]{43}$/.test(token))return false;
    const state=await read(),hash=createHash('sha256').update(token).digest('hex');
    const binding=state.driverTokens.find(row=>row.hash===hash);
    if(!binding)return false;
    const device=state.devices.find(row=>row.id===binding.deviceId&&row.businessId===binding.businessId&&!row.revokedAt&&row.expiresAt>now());
    return Boolean(device&&state.codes.some(row=>row.id===device.codeId&&row.businessId===binding.businessId&&row.enabled));
  };
  return {read,change,list,inspectionSettings,setInspectionSettings,createCode,resetCode,disableCode,signOutDevice,touchDevice,enroll,resolve,bindDriverToken,driverTokenAccess};
}
