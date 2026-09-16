import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getApps } from 'firebase-admin/app';
import { openGoogleIdentity } from '../dist/index.js';
const assertRuntimeConfiguration = () => {};

test('denied activation never initializes an SDK app', async () => {
  const before = getApps().length;
  await assert.rejects(openGoogleIdentity({ projectId: 'kavaroutes', assertRuntimeConfiguration, authorizeActivation: async () => { throw new Error('ACTIVATION_DENIED'); } }), /ACTIVATION_DENIED/);
  assert.equal(getApps().length, before);
});
test('unapproved project is rejected without initializing an SDK app', async () => {
  const before = getApps().length;
  await assert.rejects(openGoogleIdentity({ projectId: 'other-project', assertRuntimeConfiguration, authorizeActivation: async () => {} }), /CONFIGURATION_DENIED/);
  assert.equal(getApps().length, before);
});
test('live adapter invokes host runtime guard before SDK initialization', async () => {
  const before = getApps().length;
  await assert.rejects(openGoogleIdentity({ projectId:'kavaroutes',authorizeActivation:async()=>{},
    assertRuntimeConfiguration:()=>{throw new Error('GOOGLE_IDENTITY_CONFIGURATION_DENIED');} }), /CONFIGURATION_DENIED/);
  assert.equal(getApps().length,before);
});
