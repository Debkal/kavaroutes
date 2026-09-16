import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,randomBytes} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {setTimeout as delay} from 'node:timers/promises';
import {Pool} from 'pg';
import {initializeDatabase} from './database.mjs';
import {validateFutureRoute} from '@kavaroutes/platform-engine/domain';

test('SOL009 planning fixture is atomic, non-replacing and route-feasible',
 {skip:process.env.KR_CLOUD_LOCAL_TEST!=='1',timeout:90000},async()=>{
 const name=`kr-sol009-fixture-${randomUUID().slice(0,8)}`,password=randomBytes(32).toString('hex');
 const docker=args=>execFileSync('docker',args,{encoding:'utf8',timeout:30000,
  stdio:['ignore','pipe','pipe'],env:{...process.env,POSTGRES_PASSWORD:password}});
 let pool;
 try{
  docker(['run','--detach','--name',name,'--label','kavaroutes.scope=sol009-fixture-disposable',
   '--publish','127.0.0.1::5432','--env','POSTGRES_PASSWORD','--env','POSTGRES_USER=kr_cloud_admin',
   '--env','POSTGRES_DB=kavaroutes_cloud',
   'postgis/postgis:17-3.5@sha256:624f5195b91d424dbebf018890148cc0e5a3e80db5467da8b53cc2ed2ce49216',
   '-c','shared_preload_libraries=pg_stat_statements']);
  const port=docker(['port',name,'5432/tcp']).trim().split(':').at(-1);
  const databaseUrl=`postgresql://kr_cloud_admin:${password}@127.0.0.1:${port}/kavaroutes_cloud`;
  pool=new Pool({connectionString:databaseUrl,max:1,connectionTimeoutMillis:1000});pool.on('error',()=>{});
  let ready=false;for(let i=0;i<60;i++){try{await pool.query('SELECT 1');ready=true;break;}catch{await delay(500);}}
  assert.ok(ready);
  await initializeDatabase({profile:'private-synthetic',port:58080,databaseUrl,
   etagSecret:`synthetic-etag-secret-${randomBytes(32).toString('hex')}`,cursorSecret:randomBytes(32).toString('hex')},
   {kr_cloud_api:randomBytes(32).toString('hex'),kr_cloud_worker:randomBytes(32).toString('hex')});
  const seed=file=>pool.query(readFileSync(new URL(file,import.meta.url),'utf8').replace(/^\\set ON_ERROR_STOP on\n/,''));
  for(const packet of ['004','005','008','009'])await seed(`seed-sol${packet}-prototype.sql`);
  const tenant='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',run='39000000-0000-4000-8000-000000000007';
  const facts=(await pool.query('SELECT nodes,feasibility FROM dispatch.route_planning_facts WHERE tenant_id=$1 AND run_id=$2',[tenant,run])).rows[0];
  assert.equal(facts.nodes.length,4);assert.equal(Object.keys(facts.feasibility.travelSeconds).length,20);
  const order=[...facts.nodes.slice(2),...facts.nodes.slice(0,2)].map(n=>n.id);
  assert.doesNotThrow(()=>validateFutureRoute(facts.nodes,order,facts.feasibility));
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM dispatch.assignment WHERE tenant_id=$1 AND run_id=$2',[tenant,run])).rows[0].n,0);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM execution.leg_execution e JOIN execution.driver_leg_proof_rule p ON p.tenant_id=e.tenant_id AND p.execution_id=e.id WHERE e.tenant_id=$1 AND e.run_id=$2 AND e.lifecycle_reference='planned'",[tenant,run])).rows[0].n,2);
  await assert.rejects(()=>seed('seed-sol009-prototype.sql'),/SOL009_FIXTURE_EXISTS_RESUME_CLIENT_WORKFLOW/);
  await pool.query('ROLLBACK');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM dispatch.run_leg WHERE tenant_id=$1 AND run_id=$2',[tenant,run])).rows[0].n,2);
 }finally{
  await pool?.end();docker(['rm','--force','--volumes',name]);
 }
});
