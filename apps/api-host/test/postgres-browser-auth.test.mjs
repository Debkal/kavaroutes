import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import {randomBytes} from 'node:crypto';
import {getApps} from 'firebase-admin/app';
import {registerGooglePostgresBrowserAuth} from '../dist/postgres-browser-auth.js';

test('denied Google/Postgres activation creates no SDK app, database connection or login route',async t=>{
  const app=Fastify({logger:false});t.after(()=>app.close());
  const before=getApps().length;
  await assert.rejects(registerGooglePostgresBrowserAuth(app,{
    origin:'https://app.kavaroutes.com',signingKey:randomBytes(32),
    pool:{connect(){assert.fail('must not access database before activation');}},
    authorizeActivation:async()=>{throw new Error('ACTIVATION_DENIED');},
  }),/ACTIVATION_DENIED/);
  assert.equal(getApps().length,before);
  assert.equal((await app.inject({method:'POST',url:'/auth/challenge'})).statusCode,404);
});
