import {createDriverAccessStore,driverAccessUuid} from './driver-access-store.mjs';

export function registerDriverAccessManagement(app,{directory,verify}){
  if(!directory)return;
  const store=createDriverAccessStore(directory);
  const base='/v1/organizations/:organizationId/driver-access';
  const deny=(reply,status=404)=>reply.code(status).header('cache-control','no-store').send({code:status===403?'REQUEST_DENIED':'RESOURCE_NOT_FOUND'});
  const authorize=async(request,reply,command=false)=>{
    const organizationId=request.params.organizationId;
    if(!driverAccessUuid.test(organizationId)){deny(reply);return null;}
    const principal=await verify(request.headers.authorization);
    if(!principal||principal.kind!=='SYNTHETIC_USER'||principal.organizationId!==organizationId||!principal.capabilities?.has('dispatch:command')||!principal.purposes?.has('ASSIGNED_SERVICE_DELIVERY')){deny(reply);return null;}
    if(command&&(request.headers.origin!=='https://app.kavaroutes.com'||!/^application\/json(?:;|$)/i.test(request.headers['content-type']??''))){deny(reply,403);return null;}
    return {organizationId,actor:String(principal.id).slice(0,80)};
  };
  const action=async(request,reply,run)=>{
    const auth=await authorize(request,reply,true);if(!auth)return;
    try{return reply.header('cache-control','no-store').send(await run(auth));}
    catch(error){if(['ACCESS_CODE_NOT_FOUND','ACCESS_DEVICE_NOT_FOUND'].includes(error.message))return deny(reply);if(['INVALID_ACCESS_CODE','INVALID_INSPECTION_SETTINGS'].includes(error.message))return reply.code(400).send({code:error.message});if(error.message==='ACCESS_CODE_LIMIT')return reply.code(409).send({code:'ACCESS_CODE_LIMIT'});throw error;}
  };
  app.get(base,async(request,reply)=>{
    const auth=await authorize(request,reply);if(!auth)return;
    return reply.header('cache-control','no-store').send(await store.list(auth.organizationId));
  });
  app.get(`${base}/inspection-settings`,async(request,reply)=>{
    const auth=await authorize(request,reply);if(!auth)return;
    return reply.header('cache-control','no-store').send(await store.inspectionSettings(auth.organizationId));
  });
  app.post(`${base}/inspection-settings`,(request,reply)=>action(request,reply,async({organizationId,actor})=>{
    const body=request.body;
    if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).join()!=='precheckDefault')throw new Error('INVALID_INSPECTION_SETTINGS');
    return store.setInspectionSettings(organizationId,body.precheckDefault,actor);
  }));
  app.post(`${base}/codes`,(request,reply)=>action(request,reply,async({organizationId,actor})=>{
    const body=request.body;
    if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).sort().join()!=='kind,label')throw new Error('INVALID_ACCESS_CODE');
    return store.createCode(organizationId,body.kind,body.label,actor);
  }));
  app.post(`${base}/codes/:id/reset`,(request,reply)=>action(request,reply,async({organizationId,actor})=>{
    if(!driverAccessUuid.test(request.params.id))throw new Error('ACCESS_CODE_NOT_FOUND');
    return store.resetCode(organizationId,request.params.id,actor);
  }));
  app.post(`${base}/codes/:id/disable`,(request,reply)=>action(request,reply,async({organizationId,actor})=>{
    if(!driverAccessUuid.test(request.params.id))throw new Error('ACCESS_CODE_NOT_FOUND');
    return store.disableCode(organizationId,request.params.id,actor);
  }));
  app.post(`${base}/devices/:id/signout`,(request,reply)=>action(request,reply,async({organizationId,actor})=>{
    if(!driverAccessUuid.test(request.params.id))throw new Error('ACCESS_DEVICE_NOT_FOUND');
    return store.signOutDevice(organizationId,request.params.id,actor);
  }));
}
