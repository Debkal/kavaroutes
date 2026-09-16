import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {DRIVER_MIGRATIONS} from '../../../packages/driver-core/src/migrations';
import {createCloudRouteStore} from '../src/cloud-route-store';
import type {RouteView} from '@kavaroutes/api-contracts/client-route-proposals';
test('saved route drafts and immutable original requests survive reopen and duplicate taps',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'kr-route-'));let db=new DatabaseSync(join(dir,'route.sqlite')),tail=Promise.resolve();
 const adapter:any={getFirstAsync:async(sql:string,...p:any[])=>db.prepare(sql).get(...p)??null,getAllAsync:async(sql:string,...p:any[])=>db.prepare(sql).all(...p),runAsync:async(sql:string,...p:any[])=>db.prepare(sql).run(...p),
 withExclusiveTransactionAsync:(fn:any)=>{const call=tail.then(async()=>{db.exec('BEGIN');try{await fn(adapter);db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e;}});tail=call.catch(()=>undefined);return call;}};
 const make=()=>createCloudRouteStore(adapter,randomUUID);
 try{
  for(const m of DRIVER_MIGRATIONS)db.exec(m.sql);let store=make();
  const view:RouteView={shiftId:randomUUID(),runId:randomUUID(),runVersion:1,factsVersion:1,shiftGeneration:randomUUID(),policyDigest:'a'.repeat(64),expectedTag:`"kr1.${'a'.repeat(43)}"`,mode:'DISPATCH_APPROVAL_REQUIRED',nodes:[],proposals:[]};
  const order=[randomUUID(),randomUUID()];await store.save(view,order);
  const [first,duplicate]=await Promise.all([store.prepare(view,order),store.prepare(view,[...order].reverse())]);expect(duplicate).toEqual(first);
  db.close();db=new DatabaseSync(join(dir,'route.sqlite'));store=make();
  expect(await store.draft(view.shiftId)).toEqual({view,order});expect((await store.commands(view.shiftId))[0]).toEqual(first);
  const receipt={proposalId:first.proposal_id,runId:view.runId,runVersion:1,state:'PENDING_DISPATCH_APPROVAL' as const};
  await expect(store.record(first,{...receipt,proposalId:randomUUID()})).rejects.toThrow('MISMATCH');
  await store.record(first,receipt);await store.record(first,receipt);
  await expect(store.record(first,{...receipt,state:'APPROVED'})).rejects.toThrow('TERMINAL_RECEIPT_CHANGED');
  const next=await store.prepare(view,order);expect(next.proposal_id).not.toBe(first.proposal_id);await store.record(next,null);
  expect((await store.commands(view.shiftId)).map(c=>c.state)).toEqual(['ACCEPTED','REJECTED']);
 }finally{db.close();rmSync(dir,{recursive:true,force:true});}
});
