import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const image = process.argv[2];
if (!/^sha256:[0-9a-f]{64}$/.test(image ?? '')) throw new Error('PINNED_IMAGE_REQUIRED');
const run = args => execFileSync('docker', args, { encoding:'utf8',timeout:60000,maxBuffer:8*1024*1024,stdio:['ignore','pipe','pipe'] });
const inspect = JSON.parse(run(['image','inspect',image]))[0];
if (inspect.Config.User !== 'node') throw new Error('NONROOT_IMAGE_REQUIRED');
const sandbox = ['run','--rm','--network','none','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges',
  '--tmpfs','/home/node/.npm:rw,nosuid,noexec,size=16777216,uid=1000,gid=1000,mode=0700'];
const sbom = JSON.parse(run([...sandbox,'--entrypoint','npm',image,'sbom','--omit=dev','--workspace=packages','--include-workspace-root','--sbom-format=cyclonedx']));
const names = ['api','config','database','health','init','main','manifest','recovery','worker'].map(name => `infra/gcp/runtime/${name}.mjs`);
names.push('packages/postgres-persistence/scripts/migration-lib.mjs');
const script = `import fs from 'node:fs';import{createHash}from'node:crypto';const names=${JSON.stringify(names)};
for(const file of fs.readdirSync('packages/postgres-persistence/migrations').sort())names.push('packages/postgres-persistence/migrations/'+file);
function walk(dir){for(const entry of fs.readdirSync(dir,{withFileTypes:true})){const path=dir+'/'+entry.name;if(entry.isDirectory())walk(path);else if(entry.isFile()&&!entry.name.endsWith('.tsbuildinfo'))names.push(path);else if(entry.isSymbolicLink())throw new Error('UNEXPECTED_COMPILED_SYMLINK');}}
for(const entry of fs.readdirSync('packages',{withFileTypes:true})){if(!entry.isDirectory())continue;const base='packages/'+entry.name;names.push(base+'/package.json');if(fs.existsSync(base+'/dist'))walk(base+'/dist');}
const hashes=Object.fromEntries(names.map(name=>[name,createHash('sha256').update(fs.readFileSync(name)).digest('hex')]));
console.log(JSON.stringify({hashes,node:process.version,forbidden:['apps/driver','apps/web','infra/gcp/runtime/integration.test.mjs'].filter(name=>fs.existsSync(name))}));`;
const payload = JSON.parse(run([...sandbox,'--entrypoint','node',image,'--input-type=module','-e',script]));
const osPackages = run([...sandbox,'--entrypoint','dpkg-query',image,'-W','-f=${Package}\t${Version}\n']);
if (payload.forbidden.length) throw new Error('UNEXPECTED_IMAGE_PAYLOAD');
for (const [path,hash] of Object.entries(payload.hashes)) {
  if (createHash('sha256').update(await readFile(resolve(path))).digest('hex') !== hash) throw new Error('IMAGE_SOURCE_DRIFT:'+path);
}
const root = resolve('.tooling/gcp/image-evidence');
await mkdir(root, { recursive:true });
const report = { scope:'local-image-evidence-not-cloud-deployment',imageId:inspect.Id,architecture:inspect.Architecture,
  os:inspect.Os,sizeBytes:inspect.Size,user:inspect.Config.User,node:payload.node,sourceHashes:payload.hashes,
  sbomFormat:sbom.bomFormat,componentCount:sbom.components?.length ?? 0,osPackageCount:osPackages.trim().split('\n').length,
  sourceLockSha256:createHash('sha256').update(await readFile('package-lock.json')).digest('hex'),
  dockerfileSha256:createHash('sha256').update(await readFile('infra/gcp/runtime/Dockerfile')).digest('hex'),
  limits:['No OS vulnerability scan or signed release attestation claimed','Registry digest will be verified after approved push'] };
await writeFile(resolve(root,'sbom.cdx.json'),JSON.stringify(sbom,null,2)+'\n');
await writeFile(resolve(root,'report.json'),JSON.stringify(report,null,2)+'\n');
await writeFile(resolve(root,'os-packages.tsv'),osPackages);
console.log(JSON.stringify({imageId:report.imageId,sizeBytes:report.sizeBytes,componentCount:report.componentCount,sourceFilesVerified:Object.keys(report.sourceHashes).length}));
