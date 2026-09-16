import {execFileSync} from 'node:child_process';
import {randomBytes} from 'node:crypto';
const cli = '.tooling/google-cloud-sdk/bin/gcloud';
const env = {...process.env,CLOUDSDK_CONFIG:'/home/chewy/kavaroutes/.tooling/gcloud-config',CLOUDSDK_CORE_DISABLE_PROMPTS:'1'};
function run(args,input) { return execFileSync(cli,[...args,'--project=kavaroutes'],{env,input,encoding:'utf8',timeout:60000,stdio:['pipe','pipe','ignore']}); }
try {
  const versions=JSON.parse(run(['secrets','versions','list','kavaroutes-wp013-runtime','--format=json(name,state)']));
  if(versions.length) { console.log('EXISTING_SECRET_RETAINED'); process.exit(0); }
  const random=()=>randomBytes(32).toString('base64url');
  const passwords={kr_cloud_admin:random(),kr_cloud_api:random(),kr_cloud_worker:random()};
  const etagSecret=`synthetic-etag-secret-${random()}`, cursorSecret=random();
  const files={'postgres-password':passwords.kr_cloud_admin,'database-passwords.json':JSON.stringify({kr_cloud_api:passwords.kr_cloud_api,kr_cloud_worker:passwords.kr_cloud_worker})};
  for(const [role,port] of [['admin',58082],['api',58080],['worker',58081]]) files[`${role}.json`]=JSON.stringify({profile:'private-synthetic',databaseUrl:`postgresql://kr_cloud_${role}:${passwords[`kr_cloud_${role}`]}@127.0.0.1:5432/kavaroutes_cloud`,etagSecret,cursorSecret,port});
  run(['secrets','versions','add','kavaroutes-wp013-runtime','--data-file=-','--format=value(name)'],JSON.stringify({files}));
  console.log('CLOUD_SECRET_INITIALIZED');
} catch { console.error('CLOUD_SECRET_SEED_FAILED'); process.exitCode=1; }
