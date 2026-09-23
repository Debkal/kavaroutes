import Fastify from 'fastify';
import {readFile} from 'node:fs/promises';
import {resolve,extname,sep} from 'node:path';

const fail=(status,code)=>{throw Object.assign(new Error(code),{status,code});};
const providers=new Set(['password','google.com','microsoft.com']);
export function admitBusinessIdentity(identity,tenantId,now=Date.now()) {
  if(identity.firebase?.tenant!==tenantId||!providers.has(identity.firebase?.sign_in_provider)||
    identity.email_verified!==true||typeof identity.uid!=='string'||!identity.uid||
    !Number.isSafeInteger(identity.auth_time)||now/1000-identity.auth_time>300||identity.auth_time>now/1000||
    String(identity.role??'').toUpperCase()==='DRIVER'||String(identity.accountType??'').toUpperCase()==='DRIVER')fail(403,'BUSINESS_SIGN_IN_REQUIRED');
  return identity.uid;
}
export function createSiteApp({config,store,identity,webRoot=resolve(import.meta.dirname,'../dist')}) {
  const app=Fastify({logger:false,bodyLimit:20000,trustProxy:false});
  const cookieName=config.local?'kr_business_session':'__Host-kr_business_session';
  const cookie=(token,maxAge)=>`${cookieName}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${config.local?'':'; Secure'}`;
  const tokenFrom=request=>{
    const matches=(request.headers.cookie??'').split(';').map(s=>s.trim()).filter(s=>s.startsWith(`${cookieName}=`));
    const token=matches.length===1?matches[0].slice(cookieName.length+1):'';
    return /^[A-Za-z0-9_-]{43}$/.test(token)?token:'';
  };
  let attempts=0,windowStart=Date.now();
  app.addHook('onRequest',async(request,reply)=>{
    reply.header('X-Content-Type-Options','nosniff').header('Referrer-Policy','no-referrer')
      .header('X-Frame-Options','DENY').header('Cross-Origin-Opener-Policy','same-origin-allow-popups')
      .header('Permissions-Policy','camera=(), microphone=(), geolocation=()')
      .header('Cache-Control','no-store');
    const authHost=config.firebase.authDomain?`https://${config.firebase.authDomain}`:'';
    reply.header('Content-Security-Policy',`default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; script-src 'self' https://apis.google.com; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self' https://identitytoolkit.googleapis.com https://securetoken.googleapis.com ${authHost}; frame-src ${authHost||"'none'"}`);
    if(!config.local)reply.header('Strict-Transport-Security','max-age=31536000');
    if(request.method==='POST'){
      if(request.headers.origin!==config.origin)fail(403,'ORIGIN_DENIED');
      if(request.headers['content-type']!=='application/json')fail(415,'JSON_REQUIRED');
      if(Date.now()-windowStart>60_000){attempts=0;windowStart=Date.now();}
      if(++attempts>60){reply.header('Retry-After','60');fail(429,'TRY_AGAIN_LATER');}
    }
  });
  app.setErrorHandler((error,_request,reply)=>reply.code(error.status??(error.statusCode===413?413:500)).send({error:error.code&&error.status?error.code:'REQUEST_UNAVAILABLE'}));
  app.get('/api/config',async()=>({authEnabled:config.authEnabled,firebase:config.authEnabled?config.firebase:null,checkoutEnabled:false}));
  app.get('/health/ready',async()=>({status:'ready',authentication:config.authEnabled?'configured':'not-configured',checkout:'deferred'}));
  const account=async request=>{
    const session=store.session(tokenFrom(request));
    if(!session||!identity)fail(401,'SIGN_IN_REQUIRED');
    let user;
    try{user=await identity.account(session.subject);}catch{fail(503,'ACCOUNT_UNAVAILABLE');}
    const validSince=user.tokensValidAfterTime?Date.parse(user.tokensValidAfterTime):0;
    if(user.disabled||!user.emailVerified||!Number.isFinite(validSince)||session.createdAt<=validSince||
      String(user.customClaims?.role??'').toUpperCase()==='DRIVER'||String(user.customClaims?.accountType??'').toUpperCase()==='DRIVER'){
      store.revoke(tokenFrom(request));fail(401,'SIGN_IN_REQUIRED');
    }
    const business=store.get(session.subject);
    if(!business||business.state==='DISABLED')fail(403,'BUSINESS_ACCESS_UNAVAILABLE');
    return {businessName:business.businessName,email:user.email??'',subscription:'PENDING',checkoutEnabled:false,softwareAccess:false};
  };
  app.post('/api/session',async(request,reply)=>{
    if(!config.authEnabled||!identity)fail(503,'SIGN_IN_UNAVAILABLE');
    const body=request.body;
    if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(key=>!['token','businessName'].includes(key))||
      typeof body.token!=='string'||body.token.length>16384||!body.token||/\s/.test(body.token))fail(400,'INVALID_REQUEST');
    let claims;
    try{claims=await identity.verify(body.token);}catch{fail(401,'SIGN_IN_FAILED');}
    const subject=admitBusinessIdentity(claims,config.firebase.tenantId);
    if(!store.get(subject)){
      const businessName=body.businessName??(claims.firebase.sign_in_provider==='password'?claims.name:undefined);
      if(typeof businessName!=='string'||!businessName.trim()||businessName.length>120||/[\x00-\x1f]/.test(businessName))fail(409,'BUSINESS_PROFILE_REQUIRED');
      store.enroll(subject,businessName.trim());
    }
    if(store.get(subject).state==='DISABLED')fail(403,'BUSINESS_ACCESS_UNAVAILABLE');
    // No roles, entitlements, application sessions or Stripe state are created.
    const old=tokenFrom(request);if(old)store.revoke(old);
    reply.header('Set-Cookie',cookie(store.issue(subject),3600));
    return {ok:true};
  });
  app.get('/api/account',async request=>account(request));
  app.post('/api/logout',async(request,reply)=>{
    store.revoke(tokenFrom(request));
    return reply.header('Set-Cookie',cookie('',0)).code(204).send();
  });
  app.post('/api/checkout',async request=>{await account(request);fail(503,'CHECKOUT_NOT_AVAILABLE');});
  app.get('/api/software',async request=>{await account(request);fail(403,'SUBSCRIPTION_NOT_ACTIVE');});
  const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.webp':'image/webp'};
  app.get('/*',async(request,reply)=>{
    const pathname=new URL(request.url,'http://local').pathname;
    if(pathname.startsWith('/api/')||pathname.startsWith('/v1/'))return reply.code(404).send({error:'NOT_FOUND'});
    const routes=new Set(['/','/sign-in','/sign-up','/reset-password','/account']);
    let file;
    try{file=routes.has(pathname)?resolve(webRoot,'index.html'):resolve(webRoot,`.${decodeURIComponent(pathname)}`);}catch{return reply.code(404).send();}
    if(!file.startsWith(`${webRoot}${sep}`))return reply.code(404).send();
    try{
      const bytes=await readFile(file);
      if(pathname.startsWith('/assets/'))reply.header('Cache-Control','public, max-age=31536000, immutable');
      return reply.type(types[extname(file)]??'application/octet-stream').send(bytes);
    }catch{return reply.code(404).type('text/plain').send('Page not found');}
  });
  return app;
}
