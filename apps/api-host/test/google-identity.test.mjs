import assert from 'node:assert/strict';
import test from 'node:test';
import { getApps } from 'firebase-admin/app';
import { assertGoogleIdentityRuntime, openHostGoogleIdentity } from '../dist/google-identity.js';

test('host denies any emulator override before SDK initialization', async () => {
  const previous=process.env.FIREBASE_AUTH_EMULATOR_HOST,before=getApps().length;
  try {
    for (const value of ['', '127.0.0.1:9099']) {
      process.env.FIREBASE_AUTH_EMULATOR_HOST=value;
      assert.throws(assertGoogleIdentityRuntime,/CONFIGURATION_DENIED/);
      await assert.rejects(openHostGoogleIdentity(async()=>{}),/CONFIGURATION_DENIED/);
      assert.equal(getApps().length,before);
    }
    delete process.env.FIREBASE_AUTH_EMULATOR_HOST;
    assert.doesNotThrow(assertGoogleIdentityRuntime);
  } finally {
    if(previous===undefined) delete process.env.FIREBASE_AUTH_EMULATOR_HOST;
    else process.env.FIREBASE_AUTH_EMULATOR_HOST=previous;
  }
});
