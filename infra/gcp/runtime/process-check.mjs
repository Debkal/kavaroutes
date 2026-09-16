import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

export async function checkProcesses(configFor) {
  const directory = await mkdtemp(join(tmpdir(), 'kr-process-test-'));
  const children = [];
  function start(role, path, env = {}) {
    const child = spawn(process.execPath, ['infra/gcp/runtime/main.mjs', role, path], { env: { ...process.env, ...env }, stdio: ['ignore','pipe','pipe'] });
    let output = '';
    const collect = chunk => { output = (output + chunk.toString()).slice(-8192); };
    child.stdout.on('data', collect); child.stderr.on('data', collect);
    const exited = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal })); });
    const item = { child, exited, output: () => output }; children.push(item); return item;
  }
  async function exitWithin(item) {
    let timer;
    try { return await Promise.race([item.exited, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('PROCESS_EXIT_TIMEOUT')), 10000); })]); }
    finally { clearTimeout(timer); }
  }
  try {
    for (const role of ['api','worker']) {
      const config = { ...configFor(role), port: await freePort() };
      const path = join(directory, `${role}.json`);
      await writeFile(path, JSON.stringify(config), { mode: 0o600 });
      const item = start(role, path);
      let ready = false;
      for (let attempt = 0; attempt < 80; attempt++) {
        try { const response = await fetch(`http://127.0.0.1:${config.port}/health/ready`, { signal: AbortSignal.timeout(500) }); ready = response.status === 200; await response.arrayBuffer(); } catch { /* startup pending */ }
        if (ready || item.child.exitCode !== null) break;
        await delay(100);
      }
      assert.equal(ready, true, `${role} process readiness`);
      item.child.kill(role === 'api' ? 'SIGTERM' : 'SIGINT');
      assert.deepEqual(await exitWithin(item), { code: 0, signal: null });
      assert.equal(item.output().trim(), 'RUNTIME_STARTED_PRIVATE_SYNTHETIC');
      const production = start(role, path, { NODE_ENV: 'production' });
      assert.equal((await exitWithin(production)).code, 1);
      assert.equal(production.output().trim(), 'RUNTIME_START_FAILED');
      const bad = { ...config, databaseUrl: config.databaseUrl.replace(/:[^:@]+@/, ':synthetic-wrong-password@') };
      await writeFile(path, JSON.stringify(bad));
      const denied = start(role, path);
      assert.equal((await exitWithin(denied)).code, 1);
      assert.equal(denied.output().trim(), 'RUNTIME_START_FAILED');
    }
  } finally {
    for (const item of children) if (item.child.exitCode === null && item.child.signalCode === null) item.child.kill('SIGKILL');
    await Promise.allSettled(children.map(item => item.exited));
    await rm(directory, { recursive: true, force: true });
  }
}
