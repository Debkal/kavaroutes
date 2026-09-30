import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const root=fileURLToPath(new URL('..',import.meta.url));
for(const directory of ['dist','dist-driver']){
  const assets=path.join(root,'apps/web',directory,'assets');
  const entries=(await readdir(assets)).filter(name=>name.endsWith('.js'));
  assert.ok(entries.length>0,`${directory}: missing JavaScript bundle`);
  for(const file of entries){
    const source=await readFile(path.join(assets,file),'utf8');
    for(const marker of ['trip-synthetic-','facility-synthetic-alpha','idempotency-stable-1','CANARY_SECRET_TOKEN'])
      assert.ok(!source.includes(marker),`${directory}/${file}: test fixture shipped (${marker})`);
  }
}
console.log('Dispatch and Driver production bundles contain no maintained harness fixtures.');
