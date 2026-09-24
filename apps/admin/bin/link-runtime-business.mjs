// Offline operator command: bind an already provisioned runtime tenant to its
// matching admin business ID. Tenant provisioning itself is a separate step.
import {readConfig} from '../src/config.mjs';
import {openStore} from '../src/store.mjs';

const [configPath,id,name]=process.argv.slice(2);
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
if(!configPath||!uuid.test(id??'')||typeof name!=='string'||!name.trim()||name.length>120||/[\x00-\x1f]/.test(name)){
  console.error('Usage: node link-runtime-business.mjs CONFIG_PATH BUSINESS_ID BUSINESS_NAME');process.exit(2);
}
const config=readConfig(configPath),store=openStore(config.database);
try{
  store.transaction(()=>{
    const owners=store.all("SELECT email FROM admins WHERE role='OWNER' AND state='ACTIVE'");
    if(owners.length!==1)throw Error('SINGLE_ACTIVE_OWNER_REQUIRED');
    const existing=store.get('SELECT id,name FROM businesses WHERE id=?',id);
    if(existing&&existing.name!==name)throw Error('BUSINESS_NAME_MISMATCH');
    if(!existing){
      const now=Date.now();
      store.run("INSERT INTO businesses(id,name,contact,status,plan,version,created,updated) VALUES(?,?,?,'TRIAL','STARTER',1,?,?)",
        id,name,owners[0].email,now,now);
      store.audit('operator','TEST_BUSINESS_CREATED',id);
    }
    const linked=store.get('SELECT tenant_id FROM business_workspaces WHERE business_id=?',id);
    if(linked&&linked.tenant_id!==id)throw Error('BUSINESS_TENANT_MISMATCH');
    store.run(`INSERT INTO business_workspaces(business_id,tenant_id,logging_enabled) VALUES(?,?,1)
      ON CONFLICT(business_id) DO UPDATE SET logging_enabled=1`,id,id);
    store.audit('operator','BUSINESS_WORKSPACE_LINKED',id);
  });
  console.log(`BUSINESS_WORKSPACE_LINKED ${name} ${id}`);
}catch(error){console.error(error.message);process.exitCode=1;}
finally{store.close();}
