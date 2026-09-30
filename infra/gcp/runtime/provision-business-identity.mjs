// Explicit offline admission. The caller supplies a provider-verified subject,
// never an email-only link. Existing tenant data and worker enrollment are retained.
import {randomUUID} from 'node:crypto';
import {readSecretJson} from './config.mjs';
import {makePool} from './database.mjs';
import {withTenantTransaction} from '@kavaroutes/postgres-persistence';
const [configFile,organizationId,issuer,subject,displayName,role]=process.argv.slice(2);
if(!configFile||!/^https:\/\/[a-z0-9.-]+(?:\/[-a-z0-9]+)?$/.test(issuer??'')||!subject||subject.length>128||!displayName||displayName.length>120||
 !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(organizationId??'')||!['OWNER','DISPATCHER'].includes(role)){
 console.error('Usage: provision-business-identity.mjs ADMIN_CONFIG ORGANIZATION_ID VERIFIED_ISSUER VERIFIED_SUBJECT DISPLAY_NAME OWNER|DISPATCHER');process.exit(2);
}
const config=await readSecretJson(configFile);
if(new URL(config.databaseUrl).username!=='kr_cloud_admin')throw Error('PROVISIONING_DATABASE_ROLE_REQUIRED');
const pool=makePool(config,'business-identity-provisioning');
try{
 await withTenantTransaction(pool,organizationId,'kavaroutes_migration',async c=>{
  const organization=(await c.query('SELECT id FROM platform.organization WHERE tenant_id=$1 AND id=$1',[organizationId])).rows[0];
  if(!organization)throw Error('BUSINESS_NOT_PROVISIONED');
  const existing=(await c.query('SELECT user_id FROM platform.identity_binding WHERE tenant_id=$1 AND issuer=$2 AND subject=$3',[organizationId,issuer,subject])).rows[0];
  const userId=existing?.user_id??randomUUID(),principalId=randomUUID();
  if(existing){
   const membership=(await c.query('SELECT role FROM platform.application_membership WHERE tenant_id=$1 AND user_id=$2',[organizationId,userId])).rows[0];
   if(membership&&membership.role!=='DISPATCHER')throw Error('BUSINESS_ROLE_CONFLICT');
  }
  await c.query(`INSERT INTO platform.application_user(tenant_id,id,display_name,active) VALUES($1,$2,$3,true)
   ON CONFLICT(tenant_id,id) DO UPDATE SET display_name=EXCLUDED.display_name,active=true`,[organizationId,userId,displayName]);
  await c.query(`INSERT INTO platform.identity_binding(tenant_id,user_id,issuer,subject,active) VALUES($1,$2,$3,$4,true)
   ON CONFLICT(tenant_id,issuer,subject) DO UPDATE SET active=true`,[organizationId,userId,issuer,subject]);
  await c.query(`INSERT INTO platform.application_membership(tenant_id,user_id,principal_id,active,role) VALUES($1,$2,$3,true,'DISPATCHER')
   ON CONFLICT(tenant_id,user_id) DO UPDATE SET active=true,authorization_generation=platform.application_membership.authorization_generation+1`,[organizationId,userId,principalId]);
  for(const kind of ['BRANCH','FLEET'])await c.query(`INSERT INTO platform.membership_scope_grant(tenant_id,user_id,scope_kind,active) VALUES($1,$2,$3,true)
   ON CONFLICT(tenant_id,user_id,scope_kind) DO UPDATE SET active=true`,[organizationId,userId,kind]);
  if(role==='DISPATCHER')await c.query('UPDATE platform.membership_capability_grant SET active=false WHERE tenant_id=$1 AND user_id=$2',[organizationId,userId]);
  if(role==='OWNER')for(const capability of ['fleet:command','driver-policy:write','driver-policy:override','billing:read','billing:command','audit:read']){
   await c.query(`INSERT INTO platform.membership_capability_grant(tenant_id,user_id,capability,active) VALUES($1,$2,$3,true)
    ON CONFLICT(tenant_id,user_id,capability) DO UPDATE SET active=true`,[organizationId,userId,capability]);
  }
 },'serializable');
 console.log('BUSINESS_IDENTITY_PROVISIONED');
}finally{await pool.end();}
