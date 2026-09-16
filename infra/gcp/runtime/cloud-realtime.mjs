import WebSocket from 'ws';
import {randomUUID} from 'node:crypto';
const tenant='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const base='http://127.0.0.1:58080';
const headers={authorization:'Synthetic principal_dispatcher','content-type':'application/json'};
const scope={streamKind:'DISPATCH_DAY',scopeReference:'branch:synthetic-all',serviceDate:'2026-09-12'};
const tripId=randomUUID();
let socket;
const deadline=setTimeout(()=>{console.error('CLOUD_REALTIME_TIMEOUT');process.exit(1);},30000);
try {
  const response=await fetch(`${base}/v1/organizations/${tenant}/runtime-dispatch-snapshot?serviceDate=${scope.serviceDate}`,{headers});
  if(response.status!==200) throw Error();
  const snapshot=await response.json();
  let liveResolve, changeResolve, fail;
  const failed=new Promise((_,reject)=>{fail=reject;});
  const live=Promise.race([new Promise(resolve=>{liveResolve=resolve;}),failed]);
  const changed=Promise.race([new Promise(resolve=>{changeResolve=resolve;}),failed]);
  live.catch(()=>{}); changed.catch(()=>{});
  socket=new WebSocket('ws://127.0.0.1:58080/v1/realtime','kavaroutes.realtime.v1',{headers:{...headers,origin:'http://kavaroutes.test'}});
  socket.on('error',fail);
  socket.on('message',raw=>{
    try {
      const frame=JSON.parse(raw);
      if(frame.type==='connection.ready') socket.send(JSON.stringify({type:'subscription.subscribe',messageId:'message:cloud:1',subscriptionId:'subscription:cloud:1',organizationId:tenant,purpose:'DISPATCH_CONTROL',scope,cursor:snapshot.cursor}));
      if(frame.type==='subscription.live') liveResolve();
      if(frame.type==='change.batch' && frame.changes.some(c=>c.delta.resourceReference===`trip:${tripId}`)) changeResolve();
    } catch { fail(Error()); }
  });
  await live;
  const created=await fetch(`${base}/v1/organizations/${tenant}/trips`,{method:'POST',headers:{...headers,'idempotency-key':randomUUID()},body:JSON.stringify({tripId,riderId:'11111111-1111-4111-8111-111111111112',serviceDate:scope.serviceDate,serviceTimezone:'America/Los_Angeles',localServiceTime:'08:00:00',resolvedServiceAt:'2026-09-12T15:00:00.000Z',resolvedUtcOffsetSeconds:-25200,ambiguityPolicy:'reject'})});
  if(created.status!==201) throw Error();
  await changed;
  const replay=await fetch(`${base}/v1/organizations/${tenant}/realtime-change-queries`,{method:'POST',headers,body:JSON.stringify({purpose:'DISPATCH_CONTROL',scope,cursor:snapshot.cursor,limit:100})});
  if(replay.status!==200 || !(await replay.json()).changes.some(c=>c.delta.resourceReference===`trip:${tripId}`)) throw Error();
  console.log('CLOUD_REALTIME_LIVE_AND_REPLAY_PASSED');
} catch {console.error('CLOUD_REALTIME_FAILED');process.exitCode=1;}
finally {clearTimeout(deadline);socket?.terminate();}
