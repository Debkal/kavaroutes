import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {createReadStream} from 'node:fs';
import {copyFile,link,readFile,stat,unlink} from 'node:fs/promises';
import {homedir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const native=path.join(root,'apps/driver-native');
const output=path.join(native,'android/app/build/outputs/apk/release');

export function apkName(version){
  if(typeof version!=='string'||!/^\d+\.\d+\.\d+$/.test(version))throw new Error('Expected a three-part numeric Driver app version.');
  return `kararoutes_driverv${version.replaceAll('.','')}.apk`;
}

async function sha256(file){
  const hash=createHash('sha256');
  for await(const chunk of createReadStream(file))hash.update(chunk);
  return hash.digest('hex');
}

async function copyOnce(source,destination,expectedHash){
  try{
    if((await sha256(destination))!==expectedHash)throw new Error(`A different APK already exists at ${destination}; bump the app version before publishing a changed build.`);
    return;
  }catch(error){if(error?.code!=='ENOENT')throw error;}
  const temporary=`${destination}.tmp-${process.pid}-${Date.now()}`;
  let copied=false;
  try{
    await copyFile(source,temporary);
    copied=true;
    if((await sha256(temporary))!==expectedHash)throw new Error(`APK copy verification failed: ${destination}`);
    try{await link(temporary,destination);}
    catch(error){
      if(error?.code!=='EEXIST'||(await sha256(destination))!==expectedHash)throw error;
    }
  }finally{if(copied)await unlink(temporary).catch(error=>{if(error?.code!=='ENOENT')throw error;});}
}

export async function packageDriverApk({configPath,outputDir,archiveDir,deliveryDir}){
  const config=JSON.parse(await readFile(configPath,'utf8'));
  const metadata=JSON.parse(await readFile(path.join(outputDir,'output-metadata.json'),'utf8'));
  const version=config?.expo?.version;
  const code=config?.expo?.android?.versionCode;
  const entry=metadata?.elements?.[0];
  if(metadata?.applicationId!=='com.kavaroutes.driver'||metadata?.variantName!=='release'||metadata?.elements?.length!==1||
    entry?.versionName!==version||entry?.versionCode!==code||entry?.outputFile!=='app-release.apk'){
    throw new Error('The release APK metadata does not match app.json; rebuild the Driver APK before publishing.');
  }
  const source=path.join(outputDir,entry.outputFile);
  if(!(await stat(source)).size)throw new Error('The Driver APK is empty.');
  if(!(await stat(archiveDir)).isDirectory()||!(await stat(deliveryDir)).isDirectory())throw new Error('The APK archive or LANFTP directory is missing.');
  const name=apkName(version);
  const hash=await sha256(source);
  const archived=path.join(archiveDir,name);
  const delivered=path.join(deliveryDir,name);
  // Check both destinations before creating either one. A changed build must
  // never silently replace an APK that was already distributed as this version.
  for(const destination of [archived,delivered]){
    try{if((await sha256(destination))!==hash)throw new Error(`A different APK already exists at ${destination}; bump the app version before publishing a changed build.`);}
    catch(error){if(error?.code!=='ENOENT')throw error;}
  }
  await copyOnce(source,archived,hash);
  await copyOnce(source,delivered,hash);
  return {name,hash,archived,delivered};
}

function buildApk(){
  const javaHome=process.env.JAVA_HOME??path.join(root,'.tooling/jdk-17');
  const androidHome=process.env.ANDROID_HOME??path.join(root,'.tooling/android-sdk');
  const result=spawnSync('./gradlew',[':app:assembleRelease'],{
    cwd:path.join(native,'android'),stdio:'inherit',
    env:{...process.env,JAVA_HOME:javaHome,ANDROID_HOME:androidHome,ANDROID_SDK_ROOT:process.env.ANDROID_SDK_ROOT??androidHome},
  });
  if(result.error)throw result.error;
  if(result.status!==0)throw new Error(`Android build failed with exit code ${result.status}.`);
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{
    if(process.argv.length>3||(process.argv[2]&&process.argv[2]!=='--package-only'))throw new Error('Usage: node scripts/build-driver-native-apk.mjs [--package-only]');
    if(process.argv[2]!=='--package-only')buildApk();
    const result=await packageDriverApk({
      configPath:path.join(native,'app.json'),outputDir:output,
      archiveDir:path.join(root,'artifacts/mobile-builds'),deliveryDir:path.join(homedir(),'lanftp-received'),
    });
    process.stdout.write(`${result.name}\nSHA-256 ${result.hash}\nArchive: ${result.archived}\nLANFTP: ${result.delivered}\n`);
  }catch(error){console.error(error instanceof Error?error.message:error);process.exitCode=1;}
}
