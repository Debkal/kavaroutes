import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const require = createRequire(import.meta.url);
const adminRequire = createRequire(require.resolve('firebase-admin/app'));
const storageRequire = createRequire(adminRequire.resolve('@google-cloud/storage'));
const gaxiosPath = storageRequire.resolve('gaxios');
const gaxiosRequire = createRequire(gaxiosPath);

test('SDK dependency anchor retains the reviewed CommonJS UUID override', () => {
  const root = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url)));
  const leaf = JSON.parse(readFileSync(new URL('../package.json', import.meta.url)));
  assert.equal(root.devDependencies['firebase-admin'], leaf.dependencies['firebase-admin']);
  assert.equal(root.overrides.uuid, '11.1.1');
  assert.equal(gaxiosRequire('uuid/package.json').version, '11.1.1');
  assert.match(gaxiosRequire('uuid').v4(), /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/);
});

test('actual SDK transport constructs multipart bodies with the patched UUID without network', async () => {
  const { Gaxios } = storageRequire('gaxios');
  let captured;
  const transport = new Gaxios({ adapter: async options => {
    const chunks = [];
    for await (const chunk of options.body) chunks.push(Buffer.from(chunk));
    captured = { type: options.headers['Content-Type'], body: Buffer.concat(chunks).toString() };
    return { config: options, data: {}, headers: {}, status: 200, statusText: 'OK' };
  } });
  await transport.request({ url: 'https://kavaroutes.invalid/test', method: 'POST',
    multipart: [{ headers: { 'Content-Type': 'text/plain' }, content: 'synthetic-only' }] });
  assert.match(captured.type, /^multipart\/related; boundary=[\da-f-]{36}$/);
  assert.ok(captured.body.includes(captured.type.split('boundary=')[1]));
  assert.ok(captured.body.includes('synthetic-only'));
});
