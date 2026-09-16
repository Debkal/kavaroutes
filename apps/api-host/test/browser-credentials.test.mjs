import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes } from 'node:crypto';
import { createBrowserCredentials,hashBrowserCredential } from '../dist/browser-credentials.js';

const origin='https://app.kavaroutes.com',tenant='71000000-0000-4000-8000-000000000001';
const setup=(extra={})=>createBrowserCredentials({origin,signingKey:randomBytes(32),...extra});
const cookie=value=>value.split(';')[0];

test('session CSRF survives host reconstruction but is bound to key and company',()=>{
  const signingKey=randomBytes(32),first=setup({signingKey}),issued=first.issue(tenant);
  const recovered=setup({signingKey}).recover(cookie(issued.cookie));
  assert.equal(recovered.csrf,issued.csrf);
  assert.equal(recovered.csrfHash,issued.csrfHash);
  assert.equal(recovered.tokenHash,issued.tokenHash);
  assert.notEqual(setup().recover(cookie(issued.cookie)).csrfHash,issued.csrfHash);
  assert.notEqual(first.recover(cookie(issued.cookie).replace(tenant,'72000000-0000-4000-8000-000000000001')).csrfHash,issued.csrfHash);
});

test('browser credentials require HTTPS canonical origin and strong signing key',()=>{
  for(const bad of ['http://app.kavaroutes.com',origin+'/',origin+'/login','https://user@app.kavaroutes.com']) {
    assert.throws(()=>setup({origin:bad}),/CONFIG_INVALID/);
  }
  assert.throws(()=>setup({signingKey:Buffer.alloc(16)}),/CONFIG_INVALID/);
});
test('state changes require exact origin and reject cross-site Fetch Metadata',()=>{
  const credentials=setup();
  credentials.assertSameOrigin({origin});
  credentials.assertSameOrigin({origin,'sec-fetch-site':'same-origin'});
  for(const headers of [{},{origin:'null'},{origin:origin+'.evil.test'},{origin,'sec-fetch-site':'same-site'},
    {origin,'sec-fetch-site':'cross-site'},{origin:[origin]}])assert.throws(()=>credentials.assertSameOrigin(headers),/DENIED/);
});
test('signed login challenge expires, binds token, and rejects tampering/duplicates',()=>{
  let now=1000;
  const credentials=setup({now:()=>now});
  const issued=credentials.challenge(),header=cookie(issued.cookie);
  credentials.verifyChallenge(header,issued.csrf);
  for(const [h,csrf] of [[header,'x'.repeat(43)],[header+'; '+header,issued.csrf],
    [header.replace('1000.','999.'),issued.csrf],[undefined,issued.csrf],['x'.repeat(5000),issued.csrf]]) {
    assert.throws(()=>credentials.verifyChallenge(h,csrf),/DENIED/);
  }
  assert.throws(()=>setup({now:()=>1000}).verifyChallenge(header,issued.csrf),/DENIED/);
  now=999;assert.throws(()=>credentials.verifyChallenge(header,issued.csrf),/DENIED/);
  now=1300;assert.throws(()=>credentials.verifyChallenge(header,issued.csrf),/DENIED/);
});
test('session cookie contains only tenant and random credential; persistence receives hashes',()=>{
  const credentials=setup(),issued=credentials.issue(tenant),second=credentials.issue(tenant);
  assert.notEqual(issued.tokenHash,second.tokenHash);
  assert.notEqual(issued.csrf,second.csrf);
  assert.notEqual(issued.tokenHash,issued.csrfHash);
  assert.equal(issued.csrfHash,hashBrowserCredential(issued.csrf));
  assert.match(issued.cookie,/^__Host-kr-session=/);
  assert.match(issued.cookie,/; Path=\/; Secure; HttpOnly; SameSite=Strict; Max-Age=3600$/);
  assert.ok(!issued.cookie.includes('Domain='));
  assert.deepEqual(credentials.read(cookie(issued.cookie),issued.csrf),{organizationId:tenant,tokenHash:issued.tokenHash,csrfHash:issued.csrfHash});
  assert.equal(credentials.read(undefined),null);
  assert.throws(()=>credentials.read(cookie(issued.cookie)+'; '+cookie(issued.cookie)),/DENIED/);
  assert.throws(()=>credentials.read(cookie(issued.cookie),'bad'),/DENIED/);
  assert.throws(()=>credentials.issue('not-a-company'),/DENIED/);
  assert.match(credentials.clearSession,/Max-Age=0$/);
  assert.match(credentials.clearChallenge,/Max-Age=0$/);
});
