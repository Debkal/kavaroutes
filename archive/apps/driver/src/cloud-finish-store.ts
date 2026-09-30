import type {SQLiteDatabase} from 'expo-sqlite';
type Db=Pick<SQLiteDatabase,'getFirstAsync'|'getAllAsync'|'runAsync'|'withExclusiveTransactionAsync'>;
export type FinishCommand={shift:string;kind:'CLOSE'|'EMERGENCY'|'LOCATION';key:string;request:unknown;receipt:unknown;state:'PENDING'|'ACCEPTED'|'REJECTED'};
const encode=(v:unknown)=>new TextEncoder().encode(JSON.stringify(v)),decode=(v:Uint8Array)=>JSON.parse(new TextDecoder().decode(v)) as unknown;
type Row={shift_reference:string;kind:FinishCommand['kind'];command_key:string;encrypted_request:Uint8Array;encrypted_receipt:Uint8Array|null;state:FinishCommand['state']};
const map=(r:Row):FinishCommand=>({shift:r.shift_reference,kind:r.kind,key:r.command_key,request:decode(r.encrypted_request),receipt:r.encrypted_receipt?decode(r.encrypted_receipt):null,state:r.state});
export function createCloudFinishStore(db:Db,uuid:()=>string){return{
 async list(shift:string){return(await db.getAllAsync<Row>('SELECT * FROM cloud_finish_command WHERE shift_reference=? ORDER BY rowid',shift)).map(map);},
 async prepare(shift:string,kind:FinishCommand['kind'],request:unknown){let command:FinishCommand|undefined;await db.withExclusiveTransactionAsync(async tx=>{
  const existing=await tx.getFirstAsync<Row>("SELECT * FROM cloud_finish_command WHERE shift_reference=? AND kind=? AND state='PENDING'",shift,kind);if(existing){command=map(existing);return;}
  command={shift,kind,key:`finish_${uuid()}`,request,receipt:null,state:'PENDING'};await tx.runAsync("INSERT INTO cloud_finish_command(shift_reference,kind,command_key,encrypted_request,state) VALUES(?,?,?,?,'PENDING')",shift,kind,command.key,encode(request));
 });return command!;},
 async record(c:FinishCommand,receipt:unknown){const state=receipt===null?'REJECTED':'ACCEPTED';const result=await db.runAsync("UPDATE cloud_finish_command SET encrypted_receipt=?,state=? WHERE command_key=? AND encrypted_request=? AND state='PENDING'",receipt===null?null:encode(receipt),state,c.key,encode(c.request));if(result.changes)return;
 const row=await db.getFirstAsync<Row>('SELECT * FROM cloud_finish_command WHERE command_key=?',c.key);if(row?.state===state&&JSON.stringify(map(row).receipt)===JSON.stringify(receipt))return;throw new Error('FINISH_RECEIPT_CHANGED');}
};}
