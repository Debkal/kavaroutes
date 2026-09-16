import type {SQLiteDatabase} from 'expo-sqlite';
import type {RouteRequest,RouteReceipt,RouteView} from '@kavaroutes/api-contracts/client-route-proposals';
type Db=Pick<SQLiteDatabase,'getFirstAsync'|'getAllAsync'|'runAsync'|'withExclusiveTransactionAsync'>;
const encode=(v:unknown)=>new TextEncoder().encode(JSON.stringify(v));
const decode=<T>(v:Uint8Array)=>JSON.parse(new TextDecoder().decode(v)) as T;
export type RouteCommand={proposal_id:string;shift_reference:string;command_key:string;request:RouteRequest;receipt:RouteReceipt|null;state:'PENDING'|'ACCEPTED'|'REJECTED'};
type Row=Omit<RouteCommand,'request'|'receipt'>&{encrypted_request:Uint8Array;encrypted_receipt:Uint8Array|null};
const map=(r:Row):RouteCommand=>({proposal_id:r.proposal_id,shift_reference:r.shift_reference,command_key:r.command_key,state:r.state,request:decode(r.encrypted_request),receipt:r.encrypted_receipt?decode(r.encrypted_receipt):null});
export function createCloudRouteStore(db:Db,uuid:()=>string){return {
 async draft(shift:string){const r=await db.getFirstAsync<{encrypted_view:Uint8Array;encrypted_order:Uint8Array}>('SELECT * FROM cloud_route_draft WHERE shift_reference=?',shift);return r?{view:decode<RouteView>(r.encrypted_view),order:decode<string[]>(r.encrypted_order)}:null;},
 async save(view:RouteView,order:string[]){await db.runAsync('INSERT INTO cloud_route_draft VALUES(?,?,?) ON CONFLICT(shift_reference) DO UPDATE SET encrypted_view=excluded.encrypted_view,encrypted_order=excluded.encrypted_order',view.shiftId,encode(view),encode(order));},
 async commands(shift:string){return (await db.getAllAsync<Row>('SELECT * FROM cloud_route_command WHERE shift_reference=? ORDER BY rowid',shift)).map(map);},
 async prepare(view:RouteView,order:string[]){let result:RouteCommand|undefined;await db.withExclusiveTransactionAsync(async tx=>{
  const pending=await tx.getFirstAsync<Row>("SELECT * FROM cloud_route_command WHERE shift_reference=? AND state='PENDING' LIMIT 1",view.shiftId);if(pending){result=map(pending);return;}
  const request:RouteRequest={proposalId:uuid(),shiftGeneration:view.shiftGeneration,policyDigest:view.policyDigest,expectedRunVersion:view.runVersion,expectedTag:view.expectedTag,nodeOrder:order,parkedAttestation:true};
  const key=`route_${uuid()}`;await tx.runAsync("INSERT INTO cloud_route_command(proposal_id,shift_reference,command_key,encrypted_request,state) VALUES(?,?,?,?,'PENDING')",request.proposalId,view.shiftId,key,encode(request));
  result={proposal_id:request.proposalId,shift_reference:view.shiftId,command_key:key,request,receipt:null,state:'PENDING'};
 });return result!;},
 async record(command:RouteCommand,receipt:RouteReceipt|null){if(receipt?.proposalId!==undefined&&receipt.proposalId!==command.proposal_id)throw new Error('ROUTE_RECEIPT_MISMATCH');
  const state=receipt?'ACCEPTED':'REJECTED';const result=await db.runAsync("UPDATE cloud_route_command SET state=?,encrypted_receipt=? WHERE proposal_id=? AND command_key=? AND encrypted_request=? AND state='PENDING'",state,receipt?encode(receipt):null,command.proposal_id,command.command_key,encode(command.request));
  if(result.changes)return;const row=await db.getFirstAsync<Row>('SELECT * FROM cloud_route_command WHERE proposal_id=?',command.proposal_id);
  if(row&&row.state===state&&JSON.stringify(map(row).receipt)===JSON.stringify(receipt))return;throw new Error('ROUTE_TERMINAL_RECEIPT_CHANGED');
 }
};}
