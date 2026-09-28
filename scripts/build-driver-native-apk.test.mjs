import {strict as assert} from 'node:assert';
import {createHash} from 'node:crypto';
import {mkdtemp,mkdir,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import {apkName,packageDriverApk} from './build-driver-native-apk.mjs';

test('versioned Driver APK is archived and delivered without changing its bytes',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'driver-apk-test-'));
  try{
    const outputDir=path.join(dir,'output');
    const archiveDir=path.join(dir,'archive');
    const deliveryDir=path.join(dir,'delivery');
    const configPath=path.join(dir,'app.json');
    await Promise.all([mkdir(outputDir),mkdir(archiveDir),mkdir(deliveryDir)]);
    await writeFile(configPath,JSON.stringify({expo:{version:'0.1.1',android:{versionCode:2}}}));
    await writeFile(path.join(outputDir,'output-metadata.json'),JSON.stringify({applicationId:'com.kavaroutes.driver',variantName:'release',elements:[{versionName:'0.1.1',versionCode:2,outputFile:'app-release.apk'}]}));
    const bytes=Buffer.from('signed-apk-fixture');
    await writeFile(path.join(outputDir,'app-release.apk'),bytes);
    const args={configPath,outputDir,archiveDir,deliveryDir};
    const result=await packageDriverApk(args);
    assert.equal(apkName('0.1.1'),'kararoutes_driverv011.apk');
    assert.equal(result.name,'kararoutes_driverv011.apk');
    assert.equal(result.hash,createHash('sha256').update(bytes).digest('hex'));
    assert.deepEqual(await readFile(result.archived),bytes);
    assert.deepEqual(await readFile(result.delivered),bytes);
    await packageDriverApk(args);
    await writeFile(path.join(outputDir,'app-release.apk'),'changed-apk');
    await assert.rejects(packageDriverApk(args),/bump the app version/);
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('refuses a stale APK whose metadata disagrees with app.json',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'driver-apk-version-test-'));
  try{
    const outputDir=path.join(dir,'output');
    const archiveDir=path.join(dir,'archive');
    const deliveryDir=path.join(dir,'delivery');
    const configPath=path.join(dir,'app.json');
    await Promise.all([mkdir(outputDir),mkdir(archiveDir),mkdir(deliveryDir)]);
    await writeFile(configPath,JSON.stringify({expo:{version:'0.1.2',android:{versionCode:3}}}));
    await writeFile(path.join(outputDir,'output-metadata.json'),JSON.stringify({applicationId:'com.kavaroutes.driver',variantName:'release',elements:[{versionName:'0.1.1',versionCode:2,outputFile:'app-release.apk'}]}));
    await writeFile(path.join(outputDir,'app-release.apk'),'stale-apk');
    await assert.rejects(packageDriverApk({configPath,outputDir,archiveDir,deliveryDir}),/does not match app.json/);
  }finally{await rm(dir,{recursive:true,force:true});}
});
