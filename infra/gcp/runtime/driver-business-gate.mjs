import {createHash,randomBytes} from 'node:crypto';
import {createDriverAccessStore} from './driver-access-store.mjs';
const cookieName='__Host-kr_driver_business';
const formCookieName='__Host-kr_driver_form';
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const lifetimeSeconds=30*24*60*60;
const digest=value=>createHash('sha256').update(value).digest('hex');
const headers={'cache-control':'no-store','content-security-policy':"default-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; style-src 'unsafe-inline'",'referrer-policy':'no-referrer','x-content-type-options':'nosniff','x-frame-options':'DENY'};
const escape=value=>String(value).replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
function destination(raw,businessId){
  let url;
  try{url=new URL(raw||'/driver','https://driver.kavaroutes.com');}catch{return `/driver?businessId=${businessId}`;}
  if(url.origin!=='https://driver.kavaroutes.com'||!['/driver','/driver-admin'].includes(url.pathname))return `/driver?businessId=${businessId}`;
  if(url.pathname==='/driver-admin')return url.pathname;
  const requestedBusiness=url.searchParams.get('businessId');
  const driverId=requestedBusiness?.toLowerCase()===businessId.toLowerCase()&&uuid.test(url.searchParams.get('driverId')??'')?url.searchParams.get('driverId'):null;
  return `/driver?businessId=${businessId}${driverId?`&driverId=${driverId}`:''}`;
}
function page(message='',next='/driver',nonce=''){
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Business access | KavaRoutes Driver</title><style>*,*:before,*:after{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;grid-template-rows:auto 1fr auto;background:#f5f8f5;color:#25443b;font:16px/1.5 system-ui,sans-serif}header,footer{padding:1.2rem max(1.5rem,calc((100vw - 68rem)/2));background:#fff}header{font-weight:700}footer{font-size:.8rem;color:#536b60}main{width:min(100% - 2.5rem,27rem);margin:auto}h1{font-size:1.8rem;line-height:1.2;margin:0 0 .7rem}p{margin:.5rem 0 1.4rem}label{display:block;font-weight:600;margin:1rem 0 .35rem}input{width:100%;min-height:2.8rem;padding:.6rem .75rem;border:1px solid #aabeb3;border-radius:.55rem;background:#fff;color:#25443b;font:inherit}button{width:100%;min-height:2.8rem;margin-top:1.5rem;padding:.6rem;border:0;border-radius:.55rem;background:#3b7056;color:#fff;font:inherit;font-weight:700;cursor:pointer}button:hover{background:#2c5743}.error{color:#9c2d30}form{background:#fff;padding:1.5rem;border:1px solid #dce7df;border-radius:.8rem}</style></head><body><header>KavaRoutes Driver</header><main><form method="post" action="/business-access"><h1>Business access</h1><p>Enter the access credentials your business provided.</p>${message?`<p class="error" role="alert">${escape(message)}</p>`:''}<input type="hidden" name="next" value="${escape(next)}"><input type="hidden" name="nonce" value="${nonce}"><label for="business">Business code</label><input id="business" name="code" autocomplete="organization" required maxlength="64"><label for="password">Business access password</label><input id="password" name="password" type="password" autocomplete="current-password" required maxlength="200"><button type="submit">Continue to Driver</button></form></main><footer>Business access · KavaRoutes</footer></body></html>`;
}
export function createDriverBusinessGate({storeDirectory,now=()=>Date.now()}){
  const store=createDriverAccessStore(storeDirectory,{now});
  const nonces=new Map(),attempts=new Map(),seen=new Map();
  const newNonce=()=>{
    for(const [key,expires] of nonces)if(expires<=now())nonces.delete(key);
    if(nonces.size>=10000)throw new Error('BUSINESS_ACCESS_BUSY');
    const token=randomBytes(24).toString('base64url');nonces.set(digest(token),now()+15*60*1000);return token;
  };
  const cookie=(request,name)=>new RegExp(`(?:^|;\\s*)${name}=([^;]+)(?:;|$)`).exec(request.headers.cookie??'')?.[1];
  const formCookie=nonce=>`${formCookieName}=${nonce}; Path=/; Max-Age=900; HttpOnly; Secure; SameSite=Strict`;
  const account=async request=>{
    const saved=await store.resolve(cookie(request,cookieName));
    if(saved&&(!seen.has(saved.deviceId)||now()-seen.get(saved.deviceId)>5*60_000)){
      seen.set(saved.deviceId,now());void store.touchDevice(saved.businessId,saved.deviceId).catch(()=>{});
    }
    return saved;
  };
  const send=(response,status,body,extra={})=>response.writeHead(status,{...headers,'content-type':'text/html; charset=utf-8',...extra}).end(body);
  const redirect=(response,location,extra={})=>response.writeHead(303,{...headers,location,...extra}).end();
  const handle=async(request,response,url)=>{
    const pathname=url.pathname;
    if(pathname==='/driver-inspection-settings'&&request.method==='GET'){
      const signed=await account(request);
      if(!signed){response.writeHead(404,{...headers}).end();return true;}
      const settings=await store.inspectionSettings(signed.businessId);
      response.writeHead(200,{...headers,'content-type':'application/json; charset=utf-8'}).end(JSON.stringify(settings));return true;
    }
    if(pathname==='/business-access'&&request.method==='GET'){
      const signed=await account(request);
      if(signed){redirect(response,destination(url.searchParams.get('next'),signed.businessId));return true;}
      const nonce=newNonce();send(response,200,page('',url.searchParams.get('next')??'/driver',nonce),{'set-cookie':formCookie(nonce)});return true;
    }
    if(pathname==='/business-access'&&request.method==='POST'){
      if(!['https://driver.kavaroutes.com','null',undefined].includes(request.headers.origin)||!/^application\/x-www-form-urlencoded(?:;|$)/i.test(request.headers['content-type']??'')){
        send(response,403,'Request denied');return true;
      }
      let body='';
      for await(const part of request){body+=part;if(body.length>4096){send(response,413,'Request too large');return true;}}
      const fields=new URLSearchParams(body),code=fields.get('code')??'',password=fields.get('password')??'',next=fields.get('next')??'/driver';
      const nonce=fields.get('nonce')??'',nonceKey=digest(nonce),nonceExpiry=nonces.get(nonceKey);
      nonces.delete(nonceKey);
      if(!/^[A-Za-z0-9_-]{32}$/.test(nonce)||!nonceExpiry||nonceExpiry<=now()||cookie(request,formCookieName)!==nonce){send(response,403,'Reload business access and try again.');return true;}
      const ip=String(request.headers['cf-connecting-ip']??request.socket.remoteAddress??'unknown').slice(0,128);
      if(attempts.size>10000)for(const [key,value] of attempts)if(now()-value.start>60000)attempts.delete(key);
      const key=ip,window=attempts.get(key)??{start:now(),count:0};
      if(now()-window.start>60000){window.start=now();window.count=0;}
      window.count++;attempts.set(key,window);
      if(window.count>10){const retryNonce=newNonce();send(response,429,page('Please wait a minute and try again.',next,retryNonce),{'set-cookie':formCookie(retryNonce)});return true;}
      const enrolled=await store.enroll(code,password,request.headers['user-agent']);
      if(!enrolled){
        const retryNonce=newNonce();send(response,401,page('Business code or password was not accepted.',next,retryNonce),{'set-cookie':formCookie(retryNonce)});return true;
      }
      const token=enrolled.token;
      redirect(response,destination(next,enrolled.businessId),{'set-cookie':[
        `${cookieName}=${token}; Path=/; Max-Age=${lifetimeSeconds}; HttpOnly; Secure; SameSite=Strict`,
        `${formCookieName}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`,
      ]});return true;
    }
    if(pathname==='/business-access/logout'&&request.method==='POST'){
      if(!await account(request)||!['https://driver.kavaroutes.com','null',undefined].includes(request.headers.origin)){send(response,403,'Request denied');return true;}
      redirect(response,'/business-access',{'set-cookie':`${cookieName}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`});return true;
    }
    return false;
  };
  return {account,handle,destination,
    bindDriverToken:(businessId,deviceId,token)=>store.bindDriverToken(businessId,deviceId,token),
    driverTokenAccess:token=>store.driverTokenAccess(token)};
}
