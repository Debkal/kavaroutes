// Build-stage only. Explicit application payload avoids shipping tests/client assets.
import { mkdir, cp, readdir, access, readFile, writeFile } from 'node:fs/promises';
// Defaults are the in-image paths. The overrides exist so this staging step can
// be executed and inspected outside Docker (the sandbox that builds it has no
// Docker socket), which is what makes the staged payload verifiable locally.
const source = process.env.KR_STAGE_SOURCE ?? '/app';
const root = process.env.KR_STAGE_ROOT ?? '/stage';
await mkdir(`${root}/packages`, { recursive: true });
const manifest = JSON.parse(await readFile(`${source}/package.json`,'utf8'));
// Runtime metadata must describe the installed server tree, not missing build tools/apps.
delete manifest.devDependencies;
delete manifest.scripts;
manifest.workspaces = ['packages/*','apps/api-host'];
await writeFile(`${root}/package.json`,JSON.stringify(manifest,null,2)+'\n');
await cp(`${source}/package-lock.json`, `${root}/package-lock.json`);
for (const entry of await readdir(`${source}/packages`, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const workspace = `${source}/packages/${entry.name}`;
  const destination = `${root}/packages/${entry.name}`;
  await mkdir(destination);
  await cp(`${workspace}/package.json`, `${destination}/package.json`);
  try { await access(`${workspace}/dist`); await cp(`${workspace}/dist`, `${destination}/dist`, { recursive: true }); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}
await mkdir(`${root}/packages/postgres-persistence/scripts`, { recursive: true });
await cp(`${source}/packages/postgres-persistence/scripts/migration-lib.mjs`, `${root}/packages/postgres-persistence/scripts/migration-lib.mjs`);
await cp(`${source}/packages/postgres-persistence/migrations`, `${root}/packages/postgres-persistence/migrations`, { recursive: true });
// The server host composition (browser authenticated profile and its guarded
// variant) is the API surface the candidate lane must be able to run. Client
// bundles stay out: they are static artifacts for the edge, and the image
// verifier asserts their absence (`apps/driver`, `apps/web`).
await mkdir(`${root}/apps/api-host`, { recursive: true });
await cp(`${source}/apps/api-host/package.json`, `${root}/apps/api-host/package.json`);
try { await access(`${source}/apps/api-host/dist`); await cp(`${source}/apps/api-host/dist`, `${root}/apps/api-host/dist`, { recursive: true }); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
await mkdir(`${root}/infra/gcp/runtime`, { recursive: true });
for (const name of ['api','backfill-outbox','config','database','driver-sessions','guarded-main','health','init','main','manifest','recovery','worker']) {
  await cp(`${source}/infra/gcp/runtime/${name}.mjs`, `${root}/infra/gcp/runtime/${name}.mjs`);
}
