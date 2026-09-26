import {lstat,readFile} from 'node:fs/promises';
import {join} from 'node:path';

const defaultDirectory='/run/kavaroutes-driver-access';
const fail=(status,code)=>{throw Object.assign(new Error(code),{status,code});};
export async function driverAccessLog(store,businessId,{directory=defaultDirectory}={}){
  if(typeof businessId!=='string'||!/^[0-9a-f-]{36}$/i.test(businessId))fail(400,'INVALID_BUSINESS');
  const linked=store.get(`SELECT b.id,b.name,w.tenant_id FROM businesses b JOIN business_workspaces w ON w.business_id=b.id WHERE b.id=?`,businessId);
  if(!linked||!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(linked.tenant_id))fail(404,'BUSINESS_WORKSPACE_NOT_FOUND');
  const path=join(directory,'access.json');
  let info;try{info=await lstat(path);}catch(error){if(error.code==='ENOENT')return {businessId,businessName:linked.name,events:[]};throw error;}
  if(!info.isFile()||info.size>3_000_000||(info.mode&0o007))fail(500,'DRIVER_ACCESS_LOG_INVALID');
  const state=JSON.parse(await readFile(path,'utf8'));
  if(state.version!==1||!Array.isArray(state.events))fail(500,'DRIVER_ACCESS_LOG_INVALID');
  const events=state.events.filter(row=>row.businessId===linked.tenant_id&&Number.isSafeInteger(row.at)&&typeof row.action==='string'&&typeof row.actor==='string'&&typeof row.target==='string').slice(-100).reverse().map(row=>({at:row.at,action:row.action,actor:row.actor,target:row.target}));
  return {businessId,businessName:linked.name,events};
}
