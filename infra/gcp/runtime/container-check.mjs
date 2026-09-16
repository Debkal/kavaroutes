import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { tenantId, riderId } from './config.mjs';

export async function checkContainers(docker, databaseName, configFor, control) {
  const image = process.env.KR_CLOUD_IMAGE;
  if (!/^sha256:[0-9a-f]{64}$/.test(image ?? '')) throw new Error('PINNED_LOCAL_IMAGE_REQUIRED');
  const directory = await mkdtemp(join(tmpdir(), 'kr-container-test-'));
  const names = [];
  try {
    for (const [role,port] of [['api',58080],['worker',58081]]) {
      const config = { ...configFor(role), port };
      const url = new URL(config.databaseUrl); url.port = '5432'; config.databaseUrl = url.toString();
      const path = join(directory, `${role}.json`);
      await writeFile(path, JSON.stringify(config), { mode: 0o600 });
      const name = `kr-cloud-test-${role}-${randomUUID().slice(0,8)}`; names.push(name);
      docker(['run','--detach','--name',name,'--label','kavaroutes.scope=cld006-disposable',
        '--network',`container:${databaseName}`,'--read-only','--cap-drop','ALL','--security-opt','no-new-privileges',
        '--pids-limit','128','--memory','384m','--cpus','1','--mount',`type=bind,src=${path},dst=/run/secrets/config.json,readonly`,
        '--health-cmd',`node infra/gcp/runtime/health.mjs ${port}`,'--health-interval','1s',
        image,role,'/run/secrets/config.json']);
      let healthy = false;
      for (let i = 0; i < 60; i++) {
        const status = docker(['inspect','--format','{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}',name]).trim();
        if (status === 'running healthy') { healthy = true; break; }
        if (status.startsWith('exited')) break;
        await delay(500);
      }
      assert.equal(healthy,true,`${role} read-only container health`);
    }
    const tripId = randomUUID();
    const payload = { tripId,riderId,serviceDate:'2026-09-12',serviceTimezone:'America/Los_Angeles',localServiceTime:'08:00:00',
      resolvedServiceAt:'2026-09-12T15:00:00.000Z',resolvedUtcOffsetSeconds:-25200,ambiguityPolicy:'reject' };
    const script = `const r=await fetch('http://127.0.0.1:58080/v1/organizations/${tenantId}/trips',{method:'POST',headers:{'content-type':'application/json',authorization:'Synthetic principal_dispatcher','idempotency-key':'${randomUUID()}'},body:${JSON.stringify(JSON.stringify(payload))}});if(r.status!==201)process.exit(1);`;
    docker(['exec',names[0],'node','--input-type=module','-e',script]);
    let consumed = false;
    for (let i = 0; i < 60; i++) {
      consumed = (await control.query('SELECT 1 FROM outbox.consumer_projection WHERE tenant_id=$1 AND aggregate_id=$2',[tenantId,tripId])).rowCount > 0;
      if (consumed) break;
      await delay(250);
    }
    assert.equal(consumed,true,'container trip-to-worker flow');
    const stats = docker(['stats','--no-stream','--format','{{json .}}',...names]).trim().split('\n').map(line => JSON.parse(line));
    await mkdir('.tooling/gcp', { recursive:true });
    await writeFile('.tooling/gcp/container-smoke-evidence.json',JSON.stringify({image,scope:'single-synthetic-trip-not-capacity-proof',
      limits:{memoryPerHost:'384m',cpusPerHost:1,pidsPerHost:128},stats:stats.map(row => ({name:row.Name,memory:row.MemUsage,cpu:row.CPUPerc,pids:row.PIDs}))},null,2)+'\n');
    // Only closed runtime status output, never a credential or a raw SQL error.
    for (const name of names) {
      docker(['stop','--time','15',name]);
      assert.equal(docker(['inspect','--format','{{.State.ExitCode}}',name]).trim(),'0');
      assert.equal(docker(['logs',name]).trim(),'RUNTIME_STARTED_PRIVATE_SYNTHETIC');
    }
  } finally {
    for (const name of names) docker(['rm','--force','--volumes',name]);
    await rm(directory, { recursive: true, force: true });
  }
}
