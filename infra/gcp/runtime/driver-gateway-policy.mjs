// Only these Driver routes are exposed at the dedicated hostname. A business
// session unlocks the web app and login endpoints for that same tenant. Driver
// session tokens remain valid for native background tracking without cookies.
const uuid='[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}';
const login=new RegExp(`^/v1/organizations/(${uuid})/driver-logins/(?:commands/verify|${uuid}/commands/claim)$`);
const driver=new RegExp(`^/v1/organizations/${uuid}/driver/(?:session/commands/sign-out|itineraries/\\d{4}-\\d{2}-\\d{2}|legs/${uuid}/road-route|action-batches|shifts/(?:commands/start|assignments/${uuid}|${uuid}/(?:status|location-batches|commands/(?:precheck|postcheck|close)|legs/${uuid}/evidence/signatures)))$`);
const driverSession=/^DriverSession dvs_[A-Za-z0-9_-]{43}$/;
const adminSession=/^DriverAdmin [A-Za-z0-9_-]{43}$/;
export function driverGatewayDecision(method,path,authorization,businessId){
  if((method==='GET'||method==='POST')&&(path==='/v1/me'||driver.test(path))&&driverSession.test(authorization??''))return 'proxy';
  if(!businessId)return 'deny';
  if(method==='GET'||method==='HEAD'){
    if(path==='/'||path==='/driver'||path==='/driver-admin'||path.startsWith('/assets/')||path==='/favicon.ico')return 'static';
  }
  if(path==='/driver-admin/session'&&method==='POST'&&!authorization)return 'proxy';
  if(((path==='/driver-admin/session'&&method==='GET')||(path==='/driver-admin/logout'&&method==='POST')||(path==='/driver-admin/drivers'&&method==='POST'))&&adminSession.test(authorization??''))return 'proxy';
  const match=method==='POST'&&!authorization?login.exec(path):null;
  if(match&&match[1].toLowerCase()===businessId.toLowerCase())return 'proxy';
  return 'deny';
}
