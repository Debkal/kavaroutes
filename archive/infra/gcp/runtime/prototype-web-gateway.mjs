import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer, request as upstreamRequest } from 'node:http';
import { connect } from 'node:net';
import { extname, resolve, sep } from 'node:path';
import {driverGatewayDecision} from './driver-gateway-policy.mjs';
import {createDriverBusinessGate} from './driver-business-gate.mjs';

const webRoot = resolve(process.env.KR_WEB_ROOT ?? '/srv/kavaroutes-web/dist');
const driverRoot = resolve(process.env.KR_DRIVER_WEB_ROOT ?? '/srv/kavaroutes-web/dist-driver');
const listenPort = Number(process.env.KR_WEB_PORT ?? 58080);
const apiPort = Number(process.env.KR_API_PORT ?? 58082);
const businessGate=createDriverBusinessGate({storeDirectory:process.env.KR_DRIVER_ACCESS_DIRECTORY});
if (![listenPort, apiPort].every(port => Number.isInteger(port) && port >= 1024 && port <= 65535) || listenPort === apiPort) {
  throw new Error('PROTOTYPE_GATEWAY_PORT_INVALID');
}

const contentTypes = Object.freeze({
  '.css': 'text/css; charset=utf-8', '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.png': 'image/png',
  '.svg': 'image/svg+xml', '.webp': 'image/webp', '.woff2': 'font/woff2',
});
const securityHeaders = Object.freeze({
  'content-security-policy': "default-src 'self'; base-uri 'none'; connect-src 'self' wss:; font-src 'self'; form-action 'self'; frame-ancestors 'none'; img-src 'self' data:; object-src 'none'; script-src 'self'; style-src 'self'",
  'cross-origin-opener-policy': 'same-origin',
  // Location sharing is the driver's live map feed; the prompt is the browser's, and a
  // refusal fails the driver sign-in by design. Camera and microphone stay disabled.
  'permissions-policy': 'camera=(), geolocation=(self), microphone=()',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
});

function cleanProxyHeaders(headers) {
  const clean = { ...headers, host: `127.0.0.1:${apiPort}` };
  for (const name of ['cf-access-jwt-assertion', 'cf-authorization', 'connection', 'cookie', 'proxy-authorization', 'proxy-connection', 'upgrade','x-kr-driver-business-id']) delete clean[name];
  return clean;
}

function proxy(request, response, businessId,loginDeviceId) {
  const headers=cleanProxyHeaders(request.headers);
  if(businessId)headers['x-kr-driver-business-id']=businessId;
  const upstream = upstreamRequest({ hostname: '127.0.0.1', port: apiPort, method: request.method,
    path: request.url, headers, timeout: 30_000 }, async upstreamResponse => {
    const headers = { ...upstreamResponse.headers };
    delete headers.connection; delete headers['keep-alive']; delete headers.server;
    if(loginDeviceId&&upstreamResponse.statusCode>=200&&upstreamResponse.statusCode<300){
      try{
        const parts=[];let size=0;
        for await(const part of upstreamResponse){size+=part.length;if(size>65536)throw new Error('DRIVER_LOGIN_RESPONSE_TOO_LARGE');parts.push(part);}
        const body=Buffer.concat(parts),token=JSON.parse(body.toString('utf8')).sessionToken;
        await businessGate.bindDriverToken(businessId,loginDeviceId,token);
        response.writeHead(upstreamResponse.statusCode,headers).end(body);
      }catch(error){
        process.stderr.write(`DRIVER_SESSION_BIND_ERROR ${error instanceof Error?error.message:'unknown'}\n`);
        if(!response.headersSent)response.writeHead(503,{'content-type':'application/json','cache-control':'no-store'});
        response.end('{"code":"DRIVER_SESSION_UNAVAILABLE"}');
      }
      return;
    }
    response.writeHead(upstreamResponse.statusCode ?? 502, headers);
    upstreamResponse.pipe(response);
  });
  upstream.on('timeout', () => upstream.destroy(new Error('UPSTREAM_TIMEOUT')));
  upstream.on('error', () => {
    if (!response.headersSent) response.writeHead(502, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    response.end('{"status":"unavailable"}');
  });
  request.pipe(upstream);
}

async function staticResponse(request, response, pathname, root=webRoot, entry='index.html',privateAssets=false) {
  if (!['GET', 'HEAD'].includes(request.method ?? '')) {
    response.writeHead(405, { allow: 'GET, HEAD', ...securityHeaders }).end(); return;
  }
  let candidate;
  try {
    const decoded = decodeURIComponent(pathname);
    if (decoded.includes('\0')) throw new Error('INVALID_PATH');
    candidate = resolve(root, `.${decoded}`);
    if (candidate !== root && !candidate.startsWith(`${root}${sep}`)) throw new Error('INVALID_PATH');
    if ((await stat(candidate)).isDirectory()) candidate = resolve(candidate, entry);
    if (!(await stat(candidate)).isFile()) throw new Error('NOT_FILE');
  } catch {
    candidate = resolve(root, entry);
  }
  try {
    const metadata = await stat(candidate);
    const isAsset = candidate.startsWith(`${resolve(root, 'assets')}${sep}`);
    response.writeHead(200, { ...securityHeaders,
      'content-type': contentTypes[extname(candidate)] ?? 'application/octet-stream',
      'content-length': metadata.size,
      'cache-control': isAsset ? (privateAssets?'private, max-age=3600':'public, max-age=31536000, immutable') : 'no-store',
    });
    if (request.method === 'HEAD') response.end(); else createReadStream(candidate).pipe(response);
  } catch {
    response.writeHead(503, { ...securityHeaders, 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
    response.end('KavaRoutes prototype unavailable');
  }
}

const server = createServer(async(request, response) => {
  let url,pathname;
  try { url=new URL(request.url ?? '/', 'http://gateway.invalid'); pathname=url.pathname; }
  catch { response.writeHead(400).end(); return; }
  if (request.headers.host === 'driver.kavaroutes.com') {
    try{
      if(await businessGate.handle(request,response,url))return;
      const account=await businessGate.account(request);
      const decision=driverGatewayDecision(request.method,pathname,request.headers.authorization,account?.businessId);
      if(decision==='deny') {
        if(!account&&['GET','HEAD'].includes(request.method??'')&&(pathname==='/'||pathname==='/driver'||pathname==='/driver-admin')){
          const next=pathname==='/'?'/driver':`${pathname}${url.search}`;
          response.writeHead(303,{...securityHeaders,location:`/business-access?next=${encodeURIComponent(next)}`,'cache-control':'no-store'}).end();return;
        }
        response.writeHead(404,{...securityHeaders,'cache-control':'no-store'}).end();return;
      }
      if(decision==='proxy') {
        const driverToken=/^DriverSession (dvs_[A-Za-z0-9_-]{43})$/.exec(request.headers.authorization??'')?.[1];
        if(driverToken&&await businessGate.driverTokenAccess(driverToken)===false){response.writeHead(401,{...securityHeaders,'content-type':'application/json','cache-control':'no-store'}).end('{"code":"DRIVER_ACCESS_REVOKED"}');return;}
        const loginDeviceId=request.method==='POST'&&/\/driver-logins\//.test(pathname)?account?.deviceId:undefined;
        proxy(request,response,account?.businessId,loginDeviceId);return;
      }
      if(pathname==='/') {response.writeHead(303,{...securityHeaders,location:businessGate.destination('/driver',account.businessId),'cache-control':'no-store'}).end();return;}
      if(pathname==='/driver'){
        const safe=businessGate.destination(`${pathname}${url.search}`,account.businessId);
        if(`${pathname}${url.search}`!==safe){response.writeHead(303,{...securityHeaders,location:safe,'cache-control':'no-store'}).end();return;}
      }
      void staticResponse(request,response,pathname,driverRoot,'driver.html',true);return;
    }catch(error){
      process.stderr.write(`DRIVER_BUSINESS_GATE_ERROR ${error instanceof Error?error.message:'unknown'}\n`);
      if(!response.headersSent)response.writeHead(503,{...securityHeaders,'cache-control':'no-store'});
      response.end();return;
    }
  }
  // Provider usage is an admin-tunnel tool. Admin reads the loopback API
  // directly after its own owner session check; the app/driver gateway never
  // publishes this internal metrics route.
  if(/^\/v1\/organizations\/[^/]+\/dispatch\/provider-usage$/.test(pathname)){
    response.writeHead(404,{...securityHeaders,'cache-control':'no-store'}).end();return;
  }
  if (pathname === '/health/ready' || pathname.startsWith('/v1/')) proxy(request, response);
  else void staticResponse(request, response, pathname);
});
server.requestTimeout = 30_000;
server.headersTimeout = 15_000;
server.keepAliveTimeout = 5_000;
server.on('clientError', (_error, socket) => socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'));
server.on('upgrade', (request, socket, head) => {
  let pathname;
  try { pathname = new URL(request.url ?? '/', 'http://gateway.invalid').pathname; } catch { socket.destroy(); return; }
  if (pathname !== '/v1/realtime') { socket.destroy(); return; }
  const upstream = connect(apiPort, '127.0.0.1');
  upstream.setTimeout(30_000, () => upstream.destroy());
  upstream.on('connect', () => {
    const headers = cleanProxyHeaders(request.headers);
    headers.connection = 'Upgrade'; headers.upgrade = 'websocket';
    // Browsers cannot set Authorization on a WebSocket handshake. The public
    // prototype already uses the dispatcher synthetic principal for same-origin
    // REST behind Cloudflare Access; apply that same principal to its socket.
    // Keep the exception limited to this exact public origin and protocol.
    if (request.headers.host === 'app.kavaroutes.com' &&
        request.headers.origin === 'https://app.kavaroutes.com' &&
        request.headers['sec-websocket-protocol'] === 'kavaroutes.realtime.v1' &&
        request.headers.authorization === undefined) {
      headers.authorization = 'Synthetic principal_dispatcher';
    }
    // The retained synthetic runtime has one closed, non-public origin contract.
    headers.origin = 'http://kavaroutes.test';
    let opening = `${request.method} ${request.url} HTTP/${request.httpVersion}\r\n`;
    for (const [name, value] of Object.entries(headers)) if (value !== undefined) opening += `${name}: ${Array.isArray(value) ? value.join(', ') : value}\r\n`;
    upstream.write(`${opening}\r\n`); if (head.length) upstream.write(head);
    socket.pipe(upstream).pipe(socket);
  });
  upstream.on('error', () => socket.destroy());
  socket.on('error', () => upstream.destroy());
});

await stat(resolve(webRoot, 'index.html'));
await new Promise((resolveListen, reject) => {
  server.once('error', reject);
  server.listen(listenPort, '127.0.0.1', resolveListen);
});
process.stdout.write('PROTOTYPE_WEB_GATEWAY_STARTED\n');
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => server.close(() => process.exit(0)));
