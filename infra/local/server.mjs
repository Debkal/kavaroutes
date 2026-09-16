import http from 'node:http';
import {readFile} from 'node:fs/promises';
const port=process.env.KAVAROUTES_PORT??'8080';
if(!/^[0-9]{4,5}$/.test(port)||Number(port)>65535||Number(port)<1024)throw new Error('LOCAL_PORT_INVALID');
const host=`127.0.0.1:${port}`,origin=`http://${host}`;
const allowed=r=>r.headers.host===host&&(!r.headers.origin||r.headers.origin===origin);
if(process.argv.includes('--health')){
 const ready=await new Promise(resolve=>{
  const request=http.get('http://127.0.0.1:8080/health/ready',{headers:{host}},response=>{response.resume();resolve(response.statusCode===200);});
  request.on('error',()=>resolve(false));request.setTimeout(3000,()=>request.destroy());
 });
 process.exit(ready?0:1);
}
const server=http.createServer(async(req,res)=>{
 res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('Cache-Control','no-store');
 if(!allowed(req)){res.writeHead(403);res.end();return;}
 const path=req.url??'';
 if(path==='/health/ready'){res.writeHead(200,{'Content-Type':'application/json'});res.end('{"status":"ready","mode":"local-synthetic"}');return;}
 if(/^\/v1\/[A-Za-z0-9_/?=&.%:-]+$/.test(path)&&!path.includes('..')){
  const headers={...req.headers,host:'127.0.0.1:58080'};delete headers.cookie;
  const upstream=http.request({hostname:'127.0.0.1',port:58080,path,method:req.method,
   headers},reply=>{res.writeHead(reply.statusCode??502,reply.headers);reply.pipe(res);});
  upstream.setTimeout(30000,()=>upstream.destroy());upstream.on('error',()=>{if(!res.headersSent)res.writeHead(502);res.end();});
  req.on('aborted',()=>upstream.destroy());req.pipe(upstream);return;
 }
 if(req.method!=='GET'&&req.method!=='HEAD'){res.writeHead(405);res.end();return;}
 const pathname=path.split('?')[0];
 const asset=/^\/assets\/[A-Za-z0-9_.-]+$/.test(pathname);
 if(!asset&&!['/','/dispatch','/facility','/forbidden','/session-expired'].includes(pathname)){res.writeHead(404);res.end();return;}
 try{
  const body=await readFile(new URL('./public'+(asset?pathname:'/index.html'),import.meta.url));
  const ext=pathname.split('.').at(-1);res.setHeader('Content-Type',asset?({js:'text/javascript',css:'text/css',svg:'image/svg+xml',png:'image/png',woff2:'font/woff2'}[ext]??'application/octet-stream'):'text/html');
  res.end(req.method==='HEAD'?undefined:body);
 }catch{res.writeHead(404);res.end();}
});
server.on('upgrade',(req,socket,head)=>{
 if(!allowed(req)||req.headers.origin!==origin||req.url!=='/v1/realtime'||req.headers['sec-websocket-protocol']!=='kavaroutes.realtime.v1'){
  socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');return;
 }
 // Closed, local-only synthetic identity bridge; never a production login proxy.
 const headers={...req.headers,host:'127.0.0.1:58080',authorization:'Synthetic principal_dispatcher',origin:'http://kavaroutes.test'};
 delete headers.cookie;
 const upstream=http.request({hostname:'127.0.0.1',port:58080,path:'/v1/realtime',headers});
 upstream.on('upgrade',(reply,peer,extra)=>{
  peer.setTimeout(0);
  socket.write('HTTP/1.1 101 Switching Protocols\r\n'+Object.entries(reply.headers).map(([k,v])=>`${k}: ${v}\r\n`).join('')+'\r\n');
  if(head.length)peer.write(head);if(extra.length)socket.write(extra);
  socket.pipe(peer).pipe(socket);socket.on('error',()=>peer.destroy());peer.on('error',()=>socket.destroy());socket.on('close',()=>peer.destroy());peer.on('close',()=>socket.destroy());
 });
 upstream.on('response',()=>socket.destroy());upstream.on('error',()=>socket.destroy());upstream.setTimeout(10000,()=>upstream.destroy());upstream.end();
});
server.listen(8080,'0.0.0.0',()=>console.log('LOCAL_SYNTHETIC_WEB_READY'));
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{server.close();setTimeout(()=>process.exit(0),5000).unref();});
