import type { SQLiteDatabase } from "expo-sqlite";
import type { DriverSignatureRequest, DriverSignatureReceipt } from "@kavaroutes/api-contracts/client-web";
type Db = Pick<SQLiteDatabase,"getFirstAsync"|"getAllAsync"|"runAsync"|"withExclusiveTransactionAsync">;
const encode = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));
const decode = <T>(v: Uint8Array) => JSON.parse(new TextDecoder().decode(v)) as T;
export type SignatureDraft = { points: [number,number][]; role: DriverSignatureRequest["role"]; unableReason: NonNullable<DriverSignatureRequest["unableReason"]>; witness: string; policyDigest: string };
export type SignatureCommand = { key: string; shift: string; leg: string; request: DriverSignatureRequest; state: "PENDING"|"ACCEPTED"|"REJECTED"; receipt: DriverSignatureReceipt|null; rejectionCode: string|null };
type Row = { command_key: string;shift_reference: string;leg_reference: string;encrypted_request: Uint8Array;encrypted_receipt: Uint8Array|null;state: SignatureCommand["state"];rejection_code: string|null };
const map = (r: Row): SignatureCommand => ({ key: r.command_key,shift: r.shift_reference,leg: r.leg_reference,request: decode(r.encrypted_request),state: r.state,receipt: r.encrypted_receipt ? decode(r.encrypted_receipt) : null,rejectionCode: r.rejection_code });
export function createCloudSignatureStore(db: Db, uuid: ()=>string) {
  return {
    async draft(shift: string,leg: string,event: string) {
      const r=await db.getFirstAsync<{ encrypted_draft: Uint8Array }>("SELECT encrypted_draft FROM cloud_signature_draft WHERE shift_reference=? AND leg_reference=? AND event=?",shift,leg,event);
      return r ? decode<SignatureDraft>(r.encrypted_draft) : null;
    },
    async saveDraft(shift: string,leg: string,event: string,draft: SignatureDraft) {
      await db.runAsync("INSERT INTO cloud_signature_draft VALUES(?,?,?,?) ON CONFLICT(shift_reference,leg_reference,event) DO UPDATE SET encrypted_draft=excluded.encrypted_draft",shift,leg,event,encode(draft));
    },
    async commands(shift: string) { return (await db.getAllAsync<Row>("SELECT * FROM cloud_signature_command WHERE shift_reference=? ORDER BY rowid",shift)).map(map); },
    async prepare(shift: string,leg: string,request: DriverSignatureRequest) {
      let command: SignatureCommand|undefined;
      await db.withExclusiveTransactionAsync(async tx=>{
        const pending=await tx.getFirstAsync<Row>("SELECT * FROM cloud_signature_command WHERE shift_reference=? AND state='PENDING' LIMIT 1",shift);
        if(pending) { if(pending.leg_reference!==leg || decode<DriverSignatureRequest>(pending.encrypted_request).event!==request.event) throw new Error("RECOVER_PRECEDING_SIGNATURE");command=map(pending);return; }
        const old=await tx.getFirstAsync<Row>("SELECT * FROM cloud_signature_command WHERE evidence_id=?",request.evidenceId);
        if(old) { if(JSON.stringify(decode(old.encrypted_request))!==JSON.stringify(request)) throw new Error("SIGNATURE_IDENTITY_CHANGED");command=map(old);return; }
        const key=`signature_${uuid()}`;
        await tx.runAsync("INSERT INTO cloud_signature_command(evidence_id,shift_reference,leg_reference,event,command_key,encrypted_request,state) VALUES(?,?,?,?,?,?,'PENDING')",request.evidenceId,shift,leg,request.event,key,encode(request));
        command={key,shift,leg,request,state:"PENDING",receipt:null,rejectionCode:null};
      });return command!;
    },
    async record(command: SignatureCommand,receipt: DriverSignatureReceipt|null,rejectionCode: string|null=null) {
      if(receipt && (receipt.evidenceId!==command.request.evidenceId || receipt.shiftReference!==command.shift || receipt.tripLegId!==command.leg || receipt.event!==command.request.event || receipt.digest!==command.request.digest)) throw new Error("SIGNATURE_RECEIPT_IDENTITY_CHANGED");
      const state=receipt ? "ACCEPTED" : "REJECTED";
      const r=await db.runAsync("UPDATE cloud_signature_command SET state=?,encrypted_receipt=?,rejection_code=? WHERE evidence_id=? AND command_key=? AND encrypted_request=? AND state='PENDING'",state,receipt ? encode(receipt) : null,rejectionCode,command.request.evidenceId,command.key,encode(command.request));
      if(r.changes)return;
      const old=await db.getFirstAsync<Row>("SELECT * FROM cloud_signature_command WHERE evidence_id=?",command.request.evidenceId);
      if(old && old.state===state && JSON.stringify(map(old).receipt)===JSON.stringify(receipt) && old.rejection_code===rejectionCode)return;
      throw new Error("SIGNATURE_TERMINAL_RECEIPT_CHANGED");
    },
  };
}
