import {randomBytes} from 'node:crypto';
import {readFile,writeFile,mkdir,chmod,chown} from 'node:fs/promises';
const random=()=>randomBytes(32).toString('base64url');
try{
 await mkdir('/secrets/bootstrap',{recursive:true,mode:0o700});await chmod('/secrets/bootstrap',0o700);
 const path='/secrets/bootstrap/identity.json';let saved;
 try{saved=JSON.parse(await readFile(path,'utf8'));}catch(error){
  if(error.code!=='ENOENT')throw error;
  saved={admin:random(),api:random(),worker:random(),etag:`synthetic-etag-secret-${random()}`,cursor:random()};
  await writeFile(path,JSON.stringify(saved),{mode:0o600,flag:'wx'});
 }
 if(Object.keys(saved).sort().join()!=='admin,api,cursor,etag,worker'||['admin','api','worker','cursor'].some(k=>!/^[-_A-Za-z0-9]{43}$/.test(saved[k]))||!/^synthetic-etag-secret-[-_A-Za-z0-9]{43}$/.test(saved.etag))throw new Error('INVALID_SAVED_IDENTITY');
 const put=async(dir,name,content,uid)=>{
  await mkdir(dir,{recursive:true});await chown(dir,uid,uid);await chmod(dir,0o700);
  const file=dir+'/'+name;await writeFile(file,content,{mode:0o600});await chown(file,uid,uid);await chmod(file,0o600);
 };
 // Debian PostGIS runs as postgres UID 999; application/init image runs UID 1000.
 await put('/secrets/postgres','password',saved.admin,999);
 for(const [role,port] of [['admin',58082],['api',58080],['worker',58081]]){
  await put('/secrets/'+role,'config.json',JSON.stringify({profile:'private-synthetic',
   databaseUrl:`postgresql://kr_cloud_${role}:${saved[role]}@127.0.0.1:5432/kavaroutes_cloud`,etagSecret:saved.etag,cursorSecret:saved.cursor,port}),1000);
 }
 await put('/secrets/admin','passwords.json',JSON.stringify({kr_cloud_api:saved.api,kr_cloud_worker:saved.worker}),1000);
 console.log('LOCAL_CREDENTIALS_READY');
}catch{console.error('LOCAL_CREDENTIALS_FAILED');process.exitCode=1;}
