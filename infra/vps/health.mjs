// Fixed local readiness checks. No credentials or response bodies are logged.
import {request} from 'node:http';
const [port,host,expected]=process.argv.slice(2);
if(!/^\d{4,5}$/.test(port??'')||Number(port)>65535||
  !['app.kavaroutes.com','kavaroutes.com','admin.kavaroutes.com'].includes(host)||!['ready','READY'].includes(expected))process.exit(1);
const probe=request({hostname:'127.0.0.1',port:Number(port),path:'/health/ready',headers:{host},timeout:4000},response=>{
  let body='';
  response.on('data',chunk=>{body+=chunk;if(body.length>8192)probe.destroy();});
  response.on('end',()=>{try{process.exit(response.statusCode===200&&JSON.parse(body).status===expected?0:1);}catch{process.exit(1);}});
  response.on('error',()=>process.exit(1));
});
probe.on('timeout',()=>probe.destroy());
probe.on('error',()=>process.exit(1));
probe.end();
