import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createBrowserCommandRecoveryStore,withTenantTransaction} from '../../../postgres-persistence/dist/index.js';

export async function verifyBrowserCommandRecovery(pool,tenantId){
 const store=createBrowserCommandRecoveryStore(pool),context={tenantId,actorId:randomUUID()};
 const first={id:randomUUID(),kind:'ASSIGN_RUN',envelope:{runId:randomUUID(),expectedVersion:1,expectedTag:'synthetic-test-tag',key:'original-synthetic-command'}};
 const prepared=await store.prepare(context,first);assert.equal(prepared.result,null);assert.equal(prepared.expired,false);
 assert.deepEqual(await createBrowserCommandRecoveryStore(pool).pending(context),prepared,'reopened server store preserves original request');
 assert.deepEqual(await store.prepare(context,first),prepared);
 await assert.rejects(()=>store.prepare(context,{...first,envelope:{...first.envelope,expectedVersion:2}}),e=>e.kind==='idempotency-mismatch');
 await assert.rejects(()=>store.prepare(context,{...first,id:randomUUID()}),e=>e.kind==='idempotency-in-progress');
 await assert.rejects(()=>store.acknowledge(context,first.id),e=>e.kind==='idempotency-in-progress');
 const other={...context,actorId:randomUUID()};assert.equal(await store.pending(other),null);
 await assert.rejects(()=>store.read(other,first.id),e=>e.kind==='relationship');
 await assert.rejects(()=>store.settle(other,first.id,{outcome:'APPLIED'}),e=>e.kind==='relationship');
 assert.equal((await withTenantTransaction(pool,'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','kavaroutes_api',db=>db.query('SELECT * FROM platform.browser_command_recovery'))).rowCount,0);
 // These are store unit receipts, not substitutes for domain/API acceptance.
 const receipt={status:200,body:{outcome:'APPLIED',version:2}};
 const settled=await store.settle(context,first.id,receipt);assert.deepEqual(settled.result,receipt);
 assert.deepEqual((await store.settle(context,first.id,{status:409})).result,receipt,'first stored authoritative result is immutable');
 await assert.rejects(()=>pool.query("UPDATE platform.browser_command_recovery SET envelope='{}' WHERE tenant_id=$1 AND id=$2",[tenantId,first.id]),e=>e.code==='23514');
 await assert.rejects(()=>pool.query("UPDATE platform.browser_command_recovery SET result='{}' WHERE tenant_id=$1 AND id=$2",[tenantId,first.id]),e=>e.code==='23514');
 await store.acknowledge(context,first.id);assert.equal(await store.pending(context),null);
 assert.equal((await store.prepare(context,first)).acknowledged,true,'old reservation cannot reopen an acknowledged command');
 assert.equal((await store.acknowledge(context,first.id)).acknowledged,true);
 const attempts=await Promise.allSettled([store.prepare(context,{...first,id:randomUUID()}),store.prepare(context,{...first,id:randomUUID()})]);
 assert.equal(attempts.filter(r=>r.status==='fulfilled').length,1);assert.equal(attempts.filter(r=>r.status==='rejected'&&r.reason.kind==='idempotency-in-progress').length,1);
 const historical=(await pool.query('SELECT count(*) FROM platform.browser_command_recovery WHERE tenant_id=$1 AND actor_id=$2',[tenantId,context.actorId])).rows[0];assert.equal(Number(historical.count),2);
}
