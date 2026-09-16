import type {SQLiteDatabase} from 'expo-sqlite';
export async function readCloudDiagnostics(db:Pick<SQLiteDatabase,'getAllAsync'>,shift?:string){
 const counts={pending:0,accepted:0,rejected:0};if(!shift)return counts;
 if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(shift))throw new Error('DIAGNOSTIC_SCOPE_INVALID');
 const tables=['cloud_driver_action','cloud_signature_command','cloud_route_command','cloud_finish_command','cloud_precheck_command','cloud_postcheck_command'];
 const sql=tables.map(table=>`SELECT state,count(*) AS total FROM ${table} WHERE shift_reference=? GROUP BY state`).join(' UNION ALL ');
 const rows=await db.getAllAsync<{state:string;total:number}>(sql,...tables.map(()=>shift));
 for(const row of rows){
  if(!['PENDING','ACCEPTED','REJECTED'].includes(row.state)||!Number.isSafeInteger(row.total)||row.total<0)throw new Error('DIAGNOSTIC_COUNTS_INVALID');
  counts[row.state.toLowerCase() as keyof typeof counts]+=row.total;
 }
 return counts;
}
