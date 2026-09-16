import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {DRIVER_MIGRATIONS} from '../../../packages/driver-core/src/migrations';
import {createCloudFinishStore} from '../src/cloud-finish-store';
test('finish and emergency original identities survive SQL reopen; terminal receipts cannot change',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'kr-finish-'));let db=new DatabaseSync(join(dir,'commands.sqlite')),tail=Promise.resolve();
 const adapter:any={getFirstAsync:async(sql:string,...p:any[])=>db.prepare(sql).get(...p)??null,getAllAsync:async(sql:string,...p:any[])=>db.prepare(sql).all(...p),runAsync:async(sql:string,...p:any[])=>db.prepare(sql).run(...p),
 withExclusiveTransactionAsync:(fn:any)=>{const call=tail.then(async()=>{db.exec('BEGIN');try{await fn(adapter);db.exec('COMMIT');}catch(error){db.exec('ROLLBACK');throw error;}});tail=call.catch(()=>undefined);return call;}};
 try{
  for(const migration of DRIVER_MIGRATIONS)db.exec(migration.sql);let store=createCloudFinishStore(adapter,randomUUID);
  const original={commandId:randomUUID(),expectedVersion:4,kind:'SIGN_OFF'};
  const [first,duplicate]=await Promise.all([store.prepare('shift','CLOSE',original),store.prepare('shift','CLOSE',{...original,expectedVersion:9})]);
  expect(duplicate).toEqual(first);
  const emergency=await store.prepare('shift','EMERGENCY',{commandId:randomUUID(),kind:'EMERGENCY_STOP'});
  db.close();db=new DatabaseSync(join(dir,'commands.sqlite'));store=createCloudFinishStore(adapter,randomUUID);
  expect(await store.list('shift')).toEqual([first,emergency]);expect(await store.list('different-shift')).toEqual([]);
  const receipt={collectionStopped:true,lifecycle:'SHIFT_ENDED'};await store.record(first,receipt);await store.record(first,receipt);
  await expect(store.record(first,null)).rejects.toThrow('FINISH_RECEIPT_CHANGED');
  await store.record(emergency,null);expect((await store.list('shift')).map(c=>c.state)).toEqual(['ACCEPTED','REJECTED']);
 }finally{db.close();rmSync(dir,{recursive:true,force:true});}
});
