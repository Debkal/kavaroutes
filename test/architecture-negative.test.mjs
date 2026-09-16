import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

test('Driver configuration permits only two reviewed public settings in its composition file', async () => {
  const fixture=await mkdtemp(path.join(tmpdir(),'kavaroutes-driver-config-'));
  try {
    await mkdir(path.join(fixture,'packages'));
    await mkdir(path.join(fixture,'apps/driver/src'),{recursive:true});
    const file=path.join(fixture,'apps/driver/src/runtime-config.ts');
    const run=()=>spawnSync(process.execPath,[new URL('../scripts/check-architecture.mjs',import.meta.url).pathname,fixture],{encoding:'utf8'});
    const permitted='const a=process.env.EXPO_PUBLIC_KAVAROUTES_BACKEND; const b=process.env.EXPO_PUBLIC_KAVAROUTES_API_URL;';
    await writeFile(file,permitted);
    assert.equal(run().status,0);
    for(const forbidden of ['process.env.SECRET','process.env.EXPO_PUBLIC_KAVAROUTES_API_URL_SECRET', 'process.env[key]', 'process["env"].SECRET']) {
      await writeFile(file,`${permitted}\nconst secret=${forbidden};`);
      assert.notEqual(run().status,0);
    }
    await writeFile(file,permitted);
    await writeFile(path.join(fixture,'apps/driver/src/leak.ts'),permitted);
    assert.notEqual(run().status,0);
  } finally { await rm(fixture,{recursive:true,force:true}); }
});

test('architecture checker denies the Admin SDK and Google identity leaf in both clients', async () => {
  const fixture = await mkdtemp(path.join(tmpdir(), 'kavaroutes-identity-boundary-'));
  try {
    await mkdir(path.join(fixture, 'packages'));
    for (const app of ['web','driver']) {
      await mkdir(path.join(fixture, 'apps', app, 'src'), { recursive: true });
      await writeFile(path.join(fixture, 'apps', app, 'src', 'leak.ts'),
        "import { getAuth } from 'firebase-admin/auth';\nimport { openGoogleIdentity } from '@kavaroutes/google-identity';\n");
    }
    const result = spawnSync(process.execPath, [new URL('../scripts/check-architecture.mjs', import.meta.url).pathname, fixture], { encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    for (const app of ['web','driver']) for (const dependency of ['firebase-admin/auth','@kavaroutes/google-identity']) {
      assert.ok(`${result.stdout}${result.stderr}`.split('\n').some(line => line.includes(`apps/${app}/src/leak.ts`) && line.includes(dependency)));
    }
  } finally { await rm(fixture, { recursive: true, force: true }); }
});

test("architecture checker fails closed on framework leakage into a domain", async () => {
  const fixture = await mkdtemp(path.join(tmpdir(), "kavaroutes-wp005-boundary-"));
  try {
    await mkdir(path.join(fixture, "apps"), { recursive: true });
    await mkdir(path.join(fixture, "packages", "bad-domain", "src", "domain"), { recursive: true });
    await writeFile(path.join(fixture, "packages", "bad-domain", "package.json"), JSON.stringify({ exports: { ".": "./dist/index.js" } }));
    await writeFile(path.join(fixture, "packages", "bad-domain", "src", "domain", "index.ts"), "import Fastify from 'fastify';\nexport { Fastify };\n");
    const result = spawnSync(process.execPath, [new URL("../scripts/check-architecture.mjs", import.meta.url).pathname, fixture], { encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}${result.stderr}`, /domain import fastify|framework\/platform leakage/);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});
