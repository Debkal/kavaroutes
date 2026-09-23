import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {createAdminServer} from '../src/server.mjs';
import {openStore} from '../src/store.mjs';

test('admin health and API stay on the admin origin and require admin sign-in',async t=>{
  const store=openStore(':memory:');
  const config={mode:'local',origin:'',encryptionKey:randomBytes(32)};
  const server=createAdminServer({config,store});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));store.close();});
  config.origin=`http://127.0.0.1:${server.address().port}`;
  const ready=await fetch(`${config.origin}/health/ready`);
  assert.equal(ready.status,200);
  assert.equal((await ready.json()).status,'READY');
  const dashboard=await fetch(`${config.origin}/api/dashboard`,{method:'POST',headers:{origin:config.origin,'content-type':'application/json'},body:'{}'});
  assert.equal(dashboard.status,401);
});
