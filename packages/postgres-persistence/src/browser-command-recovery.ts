import type {Pool,PoolClient} from 'pg';
import {PersistenceConflict,withTenantTransaction,type JsonValue} from './repositories.js';

export type BrowserCommandKind='CREATE_TRIP'|'CANCEL_TRIP'|'ASSIGN_RUN'|'DECIDE_ROUTE'|'OVERRIDE_RETURN';
export type BrowserCommandRecord={id:string;kind:BrowserCommandKind;envelope:JsonValue;result:JsonValue|null;expired:boolean;acknowledged:boolean};
type Context={tenantId:string;actorId:string};
const columns='id,kind,envelope,result,expires_at<=now() AS expired,acknowledged_at IS NOT NULL AS acknowledged';
function map(row:Record<string,unknown>):BrowserCommandRecord{return {id:String(row.id),kind:row.kind as BrowserCommandKind,envelope:row.envelope as JsonValue,result:row.result as JsonValue|null,expired:row.expired===true,acknowledged:row.acknowledged===true};}
// The API must authorize kind/resource/purpose before calling this internal port.
// Domain commands still run through their original ETag/idempotency services.
export function createBrowserCommandRecoveryStore(pool:Pool){
 const tx=<T>(c:Context,work:(db:PoolClient)=>Promise<T>)=>withTenantTransaction(pool,c.tenantId,'kavaroutes_api',work);
 const read=async(db:PoolClient,c:Context,id:string)=>{
  const row=(await db.query(`SELECT ${columns} FROM platform.browser_command_recovery WHERE tenant_id=$1 AND actor_id=$2 AND id=$3`,[c.tenantId,c.actorId,id])).rows[0];
  if(!row)throw new PersistenceConflict('relationship','command hidden');return map(row);
 };
 return {
  pending(c:Context){return tx(c,async db=>{const row=(await db.query(`SELECT ${columns} FROM platform.browser_command_recovery WHERE tenant_id=$1 AND actor_id=$2 AND acknowledged_at IS NULL`,[c.tenantId,c.actorId])).rows[0];return row?map(row):null;});},
  read(c:Context,id:string){return tx(c,db=>read(db,c,id));},
  prepare(c:Context,input:{id:string;kind:BrowserCommandKind;envelope:JsonValue}){return tx(c,async db=>{
   // Serialize only the short reservation, never an awaited domain command.
   await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[c.tenantId+':browser-command:'+c.actorId]);
   const previous=(await db.query(`SELECT ${columns},envelope=$4::jsonb AS same_envelope FROM platform.browser_command_recovery WHERE tenant_id=$1 AND actor_id=$2 AND id=$3`,[c.tenantId,c.actorId,input.id,JSON.stringify(input.envelope)])).rows[0];
   if(previous){if(previous.kind!==input.kind||!previous.same_envelope)throw new PersistenceConflict('idempotency-mismatch','original browser command differs');return map(previous);}
   const pending=await db.query('SELECT id FROM platform.browser_command_recovery WHERE tenant_id=$1 AND actor_id=$2 AND acknowledged_at IS NULL',[c.tenantId,c.actorId]);
   if(pending.rowCount)throw new PersistenceConflict('idempotency-in-progress','recover preceding browser command');
   const row=(await db.query(`INSERT INTO platform.browser_command_recovery(tenant_id,actor_id,id,kind,envelope) VALUES($1,$2,$3,$4,$5::jsonb) RETURNING ${columns}`,[c.tenantId,c.actorId,input.id,input.kind,JSON.stringify(input.envelope)])).rows[0];return map(row);
  });},
  // Internal only: the executor supplies an authoritative receipt or definitive
  // rejection. Transport failures leave the original pending request untouched.
  settle(c:Context,id:string,result:JsonValue){return tx(c,async db=>{
   await db.query('UPDATE platform.browser_command_recovery SET result=$4::jsonb,completed_at=now() WHERE tenant_id=$1 AND actor_id=$2 AND id=$3 AND result IS NULL',[c.tenantId,c.actorId,id,JSON.stringify(result)]);
   return read(db,c,id);
  });},
  acknowledge(c:Context,id:string){return tx(c,async db=>{
   const current=await read(db,c,id);
   if(current.result===null)throw new PersistenceConflict('idempotency-in-progress','command result unresolved');
   await db.query('UPDATE platform.browser_command_recovery SET acknowledged_at=now() WHERE tenant_id=$1 AND actor_id=$2 AND id=$3 AND acknowledged_at IS NULL',[c.tenantId,c.actorId,id]);
   return read(db,c,id);
  });}
 };
}
