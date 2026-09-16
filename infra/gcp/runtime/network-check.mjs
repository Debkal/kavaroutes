import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from 'ws';
import { tenantId, riderId, branchScopeReference } from './config.mjs';

async function bounded(promise, milliseconds = 15000, phase = 'UNKNOWN') {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`NETWORK_CHECK_TIMEOUT_${phase}`)), milliseconds); })]); }
  finally { clearTimeout(timer); }
}
async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

export async function checkLiveNetwork(configFor) {
  const directory = await mkdtemp(join(tmpdir(), 'kr-network-test-'));
  const children = [];
  const sockets = [];
  const headers = { authorization: 'Synthetic principal_dispatcher', 'content-type': 'application/json' };
  const tripId = randomUUID();
  const scope = { streamKind: 'DISPATCH_DAY', scopeReference: branchScopeReference, serviceDate: '2026-09-12' };
  async function start(role, port = null) {
    const config = { ...configFor(role), port: port ?? await freePort() };
    const path = join(directory, `${role}.json`);
    await writeFile(path, JSON.stringify(config), { mode: 0o600 });
    const child = spawn(process.execPath, ['infra/gcp/runtime/main.mjs', role, path], { stdio: ['ignore','pipe','pipe'] });
    let output = '';
    const collect = chunk => { output = (output + chunk.toString()).slice(-8192); };
    child.stdout.on('data', collect); child.stderr.on('data', collect);
    const exited = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal })); });
    const result = { child, exited, port: config.port, output: () => output }; children.push(result);
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        const response = await fetch(`http://127.0.0.1:${config.port}/health/ready`, { signal: AbortSignal.timeout(500) });
        const ready = response.status === 200; await response.arrayBuffer();
        if (ready) return result;
      } catch { /* startup pending */ }
      if (child.exitCode !== null) break;
      await delay(100);
    }
    throw new Error('NETWORK_PROCESS_NOT_READY');
  }
  async function stop(process, signal = 'SIGTERM') {
    process.child.kill(signal);
    assert.deepEqual(await bounded(process.exited, 15000, 'SHUTDOWN'), { code: 0, signal: null });
    assert.equal(process.output().trim(), 'RUNTIME_STARTED_PRIVATE_SYNTHETIC');
  }
  try {
    const worker = await start('worker');
    let api = await start('api');
    const base = `http://127.0.0.1:${api.port}`;
    // Establish a stream before testing delta fan-out. A first-ever stream
    // correctly invalidates an empty-vector cursor and requires a fresh snapshot.
    const warm = await fetch(`${base}/v1/organizations/${tenantId}/trips`, { method: 'POST', headers: { ...headers, 'idempotency-key': randomUUID() },
      body: JSON.stringify({ tripId:randomUUID(),riderId,serviceDate:scope.serviceDate,serviceTimezone:'America/Los_Angeles',localServiceTime:'08:00:00',
        resolvedServiceAt:'2026-09-12T15:00:00.000Z',resolvedUtcOffsetSeconds:-25200,ambiguityPolicy:'reject' }) });
    assert.equal(warm.status, 201); await warm.arrayBuffer();
    let streamReady = false;
    for (let attempt = 0; attempt < 80; attempt++) {
      const response = await fetch(`${base}/v1/organizations/${tenantId}/runtime-dispatch-snapshot?serviceDate=${scope.serviceDate}`, { headers });
      assert.equal(response.status, 200);
      if (Object.keys((await response.json()).projection).length) { streamReady = true; break; }
      await delay(100);
    }
    assert.equal(streamReady, true, 'initial stream creation');
    const snapshotResponse = await fetch(`${base}/v1/organizations/${tenantId}/runtime-dispatch-snapshot?serviceDate=${scope.serviceDate}`, { headers });
    assert.equal(snapshotResponse.status, 200);
    const snapshot = await snapshotResponse.json();
    const peers = Array.from({ length: 8 }, (_, index) => {
      const socket = new WebSocket(`ws://127.0.0.1:${api.port}/v1/realtime`, 'kavaroutes.realtime.v1', { headers: { ...headers, origin: 'http://kavaroutes.test' } });
      sockets.push(socket);
      let readyResolve, changeResolve, fail;
      const failed = new Promise((_, reject) => { fail = reject; });
      const ready = Promise.race([new Promise(resolve => { readyResolve = resolve; }), failed]);
      const changed = Promise.race([new Promise(resolve => { changeResolve = resolve; }), failed]);
      // Prevent early errors from becoming unhandled before the phase awaits them.
      ready.catch(() => {}); changed.catch(() => {});
      const closed = new Promise(resolve => socket.once('close', resolve));
      socket.on('error', fail);
      socket.on('message', raw => {
        try {
          const frame = JSON.parse(raw.toString());
          if (frame.type === 'connection.ready') socket.send(JSON.stringify({ type: 'subscription.subscribe', messageId: `message:network:${index}`,
            subscriptionId: `subscription:network:${index}`, organizationId: tenantId, purpose: 'DISPATCH_CONTROL', scope, cursor: snapshot.cursor }));
          if (frame.type === 'subscription.live') readyResolve();
          if (frame.type === 'change.batch' && frame.changes.some(change => change.delta.resourceReference === `trip:${tripId}`)) changeResolve();
        } catch { fail(new Error('NETWORK_FRAME_INVALID')); }
      });
      return { ready, changed, closed };
    });
    await bounded(Promise.all(peers.map(peer => peer.ready)), 15000, 'SUBSCRIBE');
    const create = await fetch(`${base}/v1/organizations/${tenantId}/trips`, { method: 'POST', headers: { ...headers, 'idempotency-key': randomUUID() },
      body: JSON.stringify({ tripId,riderId,serviceDate:scope.serviceDate,serviceTimezone:'America/Los_Angeles',localServiceTime:'08:00:00',
        resolvedServiceAt:'2026-09-12T15:00:00.000Z',resolvedUtcOffsetSeconds:-25200,ambiguityPolicy:'reject' }) });
    assert.equal(create.status, 201); await create.arrayBuffer();
    await bounded(Promise.all(peers.map(peer => peer.changed)), 15000, 'FANOUT');
    // Active subscriptions and concurrent HTTP work during termination.
    const requests = Array.from({ length: 12 }, () => fetch(`${base}/health/ready`, { signal: AbortSignal.timeout(4000) }).then(response => response.arrayBuffer()).catch(() => null));
    await stop(api);
    await bounded(Promise.all(peers.map(peer => peer.closed)), 15000, 'SOCKET_DRAIN');
    await Promise.all(requests);
    api = await start('api', api.port);
    const replay = await fetch(`${base}/v1/organizations/${tenantId}/realtime-change-queries`, { method:'POST', headers,
      body: JSON.stringify({ purpose:'DISPATCH_CONTROL',scope,cursor:snapshot.cursor,limit:100 }) });
    assert.equal(replay.status, 200);
    assert.equal((await replay.json()).changes.some(change => change.delta.resourceReference === `trip:${tripId}`), true);
    await stop(api); await stop(worker, 'SIGINT');
  } finally {
    sockets.forEach(socket => socket.terminate());
    for (const item of children) if (item.child.exitCode === null && item.child.signalCode === null) item.child.kill('SIGKILL');
    await Promise.allSettled(children.map(item => item.exited));
    await rm(directory, { recursive: true, force: true });
  }
}
