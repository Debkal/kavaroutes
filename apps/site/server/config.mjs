export function readConfig(env=process.env) {
  const origin=env.KR_SITE_ORIGIN??'http://127.0.0.1:4313';
  const url=new URL(origin);
  const local=url.protocol==='http:'&&url.hostname==='127.0.0.1';
  if(origin!==url.origin||(!local&&origin!=='https://kavaroutes.com'))throw new Error('SITE_ORIGIN_INVALID');
  const port=Number(env.KR_SITE_PORT??58110);
  if(!Number.isInteger(port)||port<1024||port>65535)throw new Error('SITE_PORT_INVALID');
  const firebase={apiKey:env.KR_SITE_FIREBASE_API_KEY??'',authDomain:env.KR_SITE_FIREBASE_AUTH_DOMAIN??'',
    projectId:env.KR_SITE_FIREBASE_PROJECT_ID??'kavaroutes',tenantId:env.KR_SITE_FIREBASE_TENANT_ID??''};
  if(firebase.authDomain&&!/^[a-z0-9-]+\.firebaseapp\.com$/.test(firebase.authDomain))throw new Error('SITE_AUTH_DOMAIN_INVALID');
  // A dedicated business tenant is mandatory. Default-project driver identities
  // and synthetic driver credentials cannot be exchanged for site sessions.
  const authEnabled=Boolean(firebase.apiKey&&firebase.authDomain&&firebase.tenantId);
  return {origin,local,port,firebase,authEnabled,database:env.KR_SITE_DATABASE??'/tmp/kavaroutes-site/accounts.sqlite'};
}
