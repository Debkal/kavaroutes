import {readFile} from 'node:fs/promises';
import {createHash,randomBytes,scrypt as scryptCallback,timingSafeEqual} from 'node:crypto';
import {promisify} from 'node:util';
import {companyBranchScope,companyFleetScope} from '@kavaroutes/api-contracts/security';

const scrypt=promisify(scryptCallback);
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const login=/^[A-Za-z0-9][A-Za-z0-9._@-]{2,127}$/;
const driverLogin=/^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/;
const digest=token=>createHash('sha256').update(token).digest('hex');

export function registerDriverAdmin(app,{accountsFile,driverLogins,now=()=>Date.now()}){
  if(!accountsFile)return;
  const sessions=new Map(),attempts=new Map();
  const fail=(reply,status,code)=>reply.code(status).header('cache-control','no-store').send({code});
  const body=request=>request.body&&typeof request.body==='object'&&!Array.isArray(request.body)?request.body:{};
  const origin=request=>request.headers.origin==='https://driver.kavaroutes.com';
  const load=async()=>{
    const value=JSON.parse(await readFile(accountsFile,'utf8'));
    if(!Array.isArray(value.accounts))throw new Error('DRIVER_ADMIN_ACCOUNTS_INVALID');
    return value.accounts;
  };
  const authorize=async request=>{
    const token=/^DriverAdmin ([A-Za-z0-9_-]{43})$/.exec(request.headers.authorization??'')?.[1];
    if(!token)return null;
    const saved=sessions.get(digest(token));
    if(!saved||saved.expires<=now()){if(saved)sessions.delete(digest(token));return null;}
    const accounts=await load();
    if(!accounts.some(account=>account.businessId===saved.businessId&&account.loginId===saved.loginId&&account.enabled===true))return null;
    return saved;
  };
  app.post('/driver-admin/session',async(request,reply)=>{
    if(!origin(request)||request.headers['content-type']!=='application/json')return fail(reply,403,'REQUEST_DENIED');
    const fields=body(request),loginId=fields.loginId,password=fields.password;
    if(typeof loginId!=='string'||!login.test(loginId)||typeof password!=='string'||password.length<12||password.length>200)
      return fail(reply,401,'LOGIN_REJECTED');
    const key=String(request.ip),window=attempts.get(key)??{start:now(),count:0};
    if(now()-window.start>60000){window.start=now();window.count=0;}
    if(++window.count>10){attempts.set(key,window);return fail(reply,429,'TRY_AGAIN_LATER');}
    attempts.set(key,window);
    const account=(await load()).find(row=>row.loginId===loginId&&row.enabled===true);
    // Equal-cost rejection prevents a missing login from becoming a cheap oracle.
    const salt=account?.salt??'00000000000000000000000000000000';
    const expected=account?.hash??'0'.repeat(128);
    const calculated=await scrypt(password,salt,64,{N:16384,r:8,p:1,maxmem:32*1024*1024});
    if(!account||!uuid.test(account.businessId)||!timingSafeEqual(calculated,Buffer.from(expected,'hex')))
      return fail(reply,401,'LOGIN_REJECTED');
    for(const [key,value] of sessions)if(value.expires<=now())sessions.delete(key);
    const token=randomBytes(32).toString('base64url');
    sessions.set(digest(token),{businessId:account.businessId,loginId,expires:now()+8*60*60*1000});
    return reply.header('cache-control','no-store').send({token,businessId:account.businessId,loginId});
  });
  app.get('/driver-admin/session',async(request,reply)=>{
    const account=await authorize(request);if(!account)return fail(reply,401,'SIGN_IN_REQUIRED');
    return reply.header('cache-control','no-store').send({businessId:account.businessId,loginId:account.loginId});
  });
  app.post('/driver-admin/logout',async(request,reply)=>{
    if(!origin(request))return fail(reply,403,'REQUEST_DENIED');
    const token=/^DriverAdmin ([A-Za-z0-9_-]{43})$/.exec(request.headers.authorization??'')?.[1];
    if(token)sessions.delete(digest(token));
    return reply.code(204).send();
  });
  app.post('/driver-admin/drivers',async(request,reply)=>{
    if(!origin(request)||request.headers['content-type']!=='application/json')return fail(reply,403,'REQUEST_DENIED');
    const account=await authorize(request);if(!account)return fail(reply,401,'SIGN_IN_REQUIRED');
    const fields=body(request);
    if(Object.keys(fields).sort().join()!=='displayName,loginId,workforceRelationship'||
      typeof fields.displayName!=='string'||!fields.displayName.trim()||fields.displayName.length>120||
      typeof fields.loginId!=='string'||!driverLogin.test(fields.loginId)||
      !['OWNER_OPERATOR','EMPLOYEE','CONTRACTOR'].includes(fields.workforceRelationship)||
      !/^driver-admin-[A-Za-z0-9-]{36}$/.test(request.headers['idempotency-key']??''))return fail(reply,400,'INVALID_REQUEST');
    const businessId=account.businessId;
    const principal={id:businessId,kind:'BROWSER_USER',organizationId:businessId,
      capabilities:new Set(['dispatch:command']),purposes:new Set(['ASSIGNED_SERVICE_DELIVERY']),
      branchScopes:new Set([companyBranchScope(businessId)]),fleetScopes:new Set([companyFleetScope(businessId)])};
    const result=await driverLogins.createAccount({organizationId:businessId,principal,
      key:request.headers['idempotency-key'],request:{displayName:fields.displayName.trim(),loginId:fields.loginId,workforceRelationship:fields.workforceRelationship}});
    return reply.code(201).header('cache-control','no-store').send(result.body);
  });
}
