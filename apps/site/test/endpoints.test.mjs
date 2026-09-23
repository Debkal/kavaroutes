import test from 'node:test';
import assert from 'node:assert/strict';
import {createSiteApp} from '../server/app.mjs';
import {openStore} from '../server/store.mjs';
import {readConfig} from '../server/config.mjs';

test('public site serves only business endpoints and keeps protected routes closed',async t=>{
  const config=readConfig({KR_SITE_ORIGIN:'http://127.0.0.1:4313'});
  const store=openStore(':memory:');
  const app=createSiteApp({config,store,identity:null});
  t.after(async()=>{await app.close();store.close();});
  const ready=await app.inject('/health/ready');
  assert.equal(ready.statusCode,200);
  assert.equal(ready.json().status,'ready');
  assert.equal((await app.inject('/api/config')).statusCode,200);
  assert.equal((await app.inject('/')).statusCode,200);
  assert.equal((await app.inject('/api/account')).statusCode,401);
  assert.equal((await app.inject('/api/software')).statusCode,401);
  assert.equal((await app.inject('/v1/organizations/anything/driver/itineraries/2026-09-24')).statusCode,404);
});
