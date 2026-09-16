import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {readConfig,readSecretJson} from '/app/infra/gcp/runtime/config.mjs';
import {initializeDatabase} from '/app/infra/gcp/runtime/database.mjs';
const require=createRequire('/app/package.json'),{Pool}=require('pg');
let pool;
try{
 const config=await readConfig('/run/secrets/config.json','admin');
 await initializeDatabase(config,await readSecretJson('/run/secrets/passwords.json'));
 pool=new Pool({connectionString:config.databaseUrl,max:1});
 const seeded=await pool.query("SELECT 1 FROM dispatch.run WHERE tenant_id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' AND id='39000000-0000-4000-8000-000000000007'");
 if(!seeded.rowCount){
  // Fixed synthetic service dates match the current prototype's date controls.
  // No cloud access or real Driver completion receipts are involved.
  for(const packet of ['004','005','008','009']){
   const sql=(await readFile(`/fixtures/seed-sol${packet}-prototype.sql`,'utf8')).replace(/^\\set ON_ERROR_STOP on\n/,'');
   await pool.query(sql);
  }
 }
 console.log('LOCAL_DATABASE_READY_SYNTHETIC');
}catch{console.error('LOCAL_DATABASE_INITIALIZATION_FAILED');process.exitCode=1;}
finally{await pool?.end();}
