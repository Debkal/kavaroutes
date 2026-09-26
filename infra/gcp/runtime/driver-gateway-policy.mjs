// The public Driver hostname is deliberately much narrower than the Access-gated
// Dispatch hostname. Keep this list aligned with cloud-driver-api.ts and the
// native background uploader; never expose dispatch, accounting, or command APIs.
const uuid='[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}';
const login=new RegExp(`^/v1/organizations/${uuid}/driver-logins/(?:commands/verify|${uuid}/commands/claim)$`);
const driver=new RegExp(`^/v1/organizations/${uuid}/driver/(?:itineraries/\\d{4}-\\d{2}-\\d{2}|legs/${uuid}/road-route|action-batches|shifts/(?:commands/start|assignments/${uuid}|${uuid}/(?:status|location-batches|commands/(?:precheck|postcheck|close)|legs/${uuid}/evidence/signatures)))$`);

export function driverGatewayDecision(method,path,authorization){
  if(method==='GET' || method==='HEAD'){
    if(path==='/'||path==='/driver'||path==='/driver-admin'||path.startsWith('/assets/')||path==='/favicon.ico')return 'static';
    if(path==='/health/ready')return 'proxy';
  }
  if(path==='/driver-admin/session'&&method==='POST'&&!authorization)return 'proxy';
  if(((path==='/driver-admin/session'&&method==='GET')||(path==='/driver-admin/logout'&&method==='POST')||(path==='/driver-admin/drivers'&&method==='POST'))&&
    /^DriverAdmin [A-Za-z0-9_-]{43}$/.test(authorization??''))return 'proxy';
  if(method==='POST'&&login.test(path)&&!authorization)return 'proxy';
  if((method==='GET'||method==='POST')&&
      (path==='/v1/me'||driver.test(path))&&
      /^DriverSession dvs_[A-Za-z0-9_-]{43}$/.test(authorization??''))return 'proxy';
  return 'deny';
}
