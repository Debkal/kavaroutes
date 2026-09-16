// Build-stage only. Explicit application payload avoids shipping tests/client assets.
import { mkdir, cp, readdir, access, readFile, writeFile } from 'node:fs/promises';
const root = '/stage';
await mkdir(`${root}/packages`, { recursive: true });
const manifest = JSON.parse(await readFile('/app/package.json','utf8'));
// Runtime metadata must describe the installed server tree, not missing build tools/apps.
delete manifest.devDependencies;
delete manifest.scripts;
manifest.workspaces = ['packages/*'];
await writeFile(`${root}/package.json`,JSON.stringify(manifest,null,2)+'\n');
await cp('/app/package-lock.json', `${root}/package-lock.json`);
for (const entry of await readdir('/app/packages', { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const source = `/app/packages/${entry.name}`;
  const destination = `${root}/packages/${entry.name}`;
  await mkdir(destination);
  await cp(`${source}/package.json`, `${destination}/package.json`);
  try { await access(`${source}/dist`); await cp(`${source}/dist`, `${destination}/dist`, { recursive: true }); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}
await mkdir(`${root}/packages/postgres-persistence/scripts`, { recursive: true });
await cp('/app/packages/postgres-persistence/scripts/migration-lib.mjs', `${root}/packages/postgres-persistence/scripts/migration-lib.mjs`);
await cp('/app/packages/postgres-persistence/migrations', `${root}/packages/postgres-persistence/migrations`, { recursive: true });
await mkdir(`${root}/infra/gcp/runtime`, { recursive: true });
for (const name of ['api','config','database','health','init','main','manifest','recovery','worker']) {
  await cp(`/app/infra/gcp/runtime/${name}.mjs`, `${root}/infra/gcp/runtime/${name}.mjs`);
}
