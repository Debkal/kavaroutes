import { createServer } from 'node:http';
import { readConfig } from './config.mjs';
import { createRuntimeApi } from './api.mjs';
import { createRuntimeWorker } from './worker.mjs';

let runtime;
let health;
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  const deadline = setTimeout(() => process.exit(1), 15000).unref();
  try {
    if (health) await new Promise(resolve => health.close(resolve));
    await runtime?.close();
  } catch { process.stderr.write('RUNTIME_STOP_FAILED\n'); process.exitCode = 1; }
  finally { clearTimeout(deadline); }
}
try {
  const [role, path] = process.argv.slice(2);
  if (!['api', 'worker'].includes(role) || !path) throw new Error('RUNTIME_ARGUMENTS_INVALID');
  const config = await readConfig(path, role);
  if (role === 'api') {
    runtime = await createRuntimeApi(config);
    await runtime.start();
  } else {
    runtime = await createRuntimeWorker(config);
    health = createServer(async (request, response) => {
      if (request.method !== 'GET' || request.url !== '/health/ready') { response.writeHead(404).end(); return; }
      let ready = runtime.healthy();
      try { await runtime.pool.query('SELECT 1'); } catch { ready = false; }
      response.writeHead(ready ? 200 : 503, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      response.end(JSON.stringify({ status: ready ? 'ready' : 'unavailable' }));
    });
    health.requestTimeout = 5000;
    health.headersTimeout = 5000;
    await new Promise((resolve, reject) => { health.once('error', reject); health.listen(config.port, '127.0.0.1', resolve); });
    runtime.start();
  }
  process.once('SIGTERM', () => void stop());
  process.once('SIGINT', () => void stop());
  process.stdout.write('RUNTIME_STARTED_PRIVATE_SYNTHETIC\n');
} catch {
  process.stderr.write('RUNTIME_START_FAILED\n');
  await stop();
  process.exitCode = 1;
}
