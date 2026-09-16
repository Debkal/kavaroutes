import type { SQLiteDatabase } from "expo-sqlite";
import type { DriverActionBatch, BatchReceipt, StartDriverShiftReceipt, DriverItinerary, DriverClosureView } from "@kavaroutes/api-contracts/client-web";
export type CloudStartInput = { assignmentId: string; assignmentVersion: number; serviceDate: string; idempotencyKey: string };
type Db = Pick<SQLiteDatabase, "getFirstAsync" | "getAllAsync" | "runAsync" | "withExclusiveTransactionAsync">;
const encode = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));
const decode = <T>(v: Uint8Array) => JSON.parse(new TextDecoder().decode(v)) as T;
type QueuedAction = { batchKey: string; request: DriverActionBatch; state: "PENDING" | "ACCEPTED" | "REJECTED"; receipt: BatchReceipt | null; reviewed: boolean };
export function createCloudCommandStore(db: Db, options: { uuid(): string; now(): string }) {
  const start = async () => {
    const row = await db.getFirstAsync<{ command_key: string; encrypted_request: Uint8Array; encrypted_receipt: Uint8Array | null; state: string }>("SELECT * FROM cloud_shift_start WHERE id=1");
    return row ? { request: decode<CloudStartInput>(row.encrypted_request), receipt: row.encrypted_receipt ? decode<StartDriverShiftReceipt>(row.encrypted_receipt) : null, state: row.state } : null;
  };
  const map = (row: { batch_key: string; encrypted_request: Uint8Array; encrypted_receipt: Uint8Array | null; state: QueuedAction["state"]; reviewed: number }): QueuedAction => ({
    batchKey: row.batch_key, request: decode(row.encrypted_request), receipt: row.encrypted_receipt ? decode(row.encrypted_receipt) : null, state: row.state,reviewed: row.reviewed===1 });
  return {
    start,
    async archiveEndedShift(view:DriverClosureView){
      if(view.lifecycle!=='SHIFT_ENDED'||!view.collectionStopped)throw new Error('ACCEPTED_SIGN_OFF_REQUIRED');
      await db.withExclusiveTransactionAsync(async tx=>{
        const previous=await tx.getFirstAsync<{command_key:string;encrypted_request:Uint8Array;encrypted_receipt:Uint8Array;state:string}>('SELECT * FROM cloud_shift_start WHERE id=1');
        if(!previous){
          if(await tx.getFirstAsync('SELECT 1 FROM cloud_shift_history WHERE shift_reference=?',view.shiftReference))return;
          throw new Error('ORIGINAL_SHIFT_RECEIPT_REQUIRED');
        }
        const receipt=previous.encrypted_receipt?decode<StartDriverShiftReceipt>(previous.encrypted_receipt):null;
        if(previous.state!=='ACCEPTED'||receipt?.shiftReference!==view.shiftReference||receipt.shiftGeneration!==view.shiftGeneration)throw new Error('SHIFT_CLOSURE_BINDING_CHANGED');
        for(const table of ['cloud_driver_action','cloud_signature_command','cloud_route_command','cloud_finish_command','cloud_precheck_command','cloud_postcheck_command']){
          if(await tx.getFirstAsync(`SELECT 1 FROM ${table} WHERE shift_reference=? AND state='PENDING' LIMIT 1`,view.shiftReference))throw new Error('RECOVER_PENDING_BEFORE_NEW_SHIFT');
        }
        await tx.runAsync('INSERT INTO cloud_shift_history VALUES(?,?,?,?,?)',view.shiftReference,previous.command_key,previous.encrypted_request,previous.encrypted_receipt,encode(view));
        await tx.runAsync('DELETE FROM cloud_shift_start WHERE id=1 AND command_key=?',previous.command_key);
        // Per-shift action/proof/inspection/finish ledgers are retained unchanged.
      });
    },
    async manifest() {
      const row = await db.getFirstAsync<{ encrypted_projection: Uint8Array }>("SELECT encrypted_projection FROM cloud_driver_manifest WHERE id=1");
      return row ? decode<DriverItinerary>(row.encrypted_projection) : null;
    },
    async saveManifest(manifest: DriverItinerary) {
      await db.runAsync("INSERT INTO cloud_driver_manifest(id,encrypted_projection) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET encrypted_projection=excluded.encrypted_projection",encode(manifest));
    },
    async prepareStart(input: Omit<CloudStartInput, "idempotencyKey">) {
      const previous = await start(); if (previous && previous.state !== "REJECTED") return previous;
      const request = { ...input, idempotencyKey: `shift_${options.uuid()}` };
      await db.runAsync(`INSERT INTO cloud_shift_start(id,command_key,encrypted_request,state) VALUES(1,?,?,'PENDING')
        ON CONFLICT(id) DO UPDATE SET command_key=excluded.command_key,encrypted_request=excluded.encrypted_request,encrypted_receipt=NULL,state='PENDING'
        WHERE cloud_shift_start.state='REJECTED'`,request.idempotencyKey,encode(request));
      return (await start())!;
    },
    async recordStart(key: string, receipt: StartDriverShiftReceipt | null) {
      if (receipt) receipt = { ...receipt, outcome: "APPLIED" };
      const result = await db.runAsync("UPDATE cloud_shift_start SET encrypted_receipt=?,state=? WHERE id=1 AND command_key=? AND state='PENDING'",receipt ? encode(receipt) : null,receipt ? "ACCEPTED" : "REJECTED",key);
      if (result.changes) return;
      const previous = await start(); if (previous?.request.idempotencyKey === key && previous.state === (receipt ? "ACCEPTED" : "REJECTED") && JSON.stringify(previous.receipt) === JSON.stringify(receipt)) return;
      throw new Error("SHIFT_COMMAND_IDENTITY_CHANGED");
    },
    async actions(shift: string) {
      return (await db.getAllAsync<Parameters<typeof map>[0]>("SELECT * FROM cloud_driver_action WHERE shift_reference=? ORDER BY sequence",shift)).map(map);
    },
    async enqueue(input: { shiftReference: string; shiftGeneration: string; resourceReference: string; expectedTag: string; command: DriverActionBatch["items"][number]["command"]; serverSequence: number; details?: Record<string, unknown> }) {
      const intent = `${input.resourceReference}:${input.expectedTag}:${input.command}:${JSON.stringify(input.details ?? {})}`;
      let action: QueuedAction | undefined;
      await db.withExclusiveTransactionAsync(async tx => {
        const previous = await tx.getFirstAsync<Parameters<typeof map>[0]>("SELECT * FROM cloud_driver_action WHERE shift_reference=? AND (intent_key=? OR substr(intent_key,1,length(? || ':reviewed_retry:'))=? || ':reviewed_retry:') ORDER BY sequence DESC LIMIT 1",input.shiftReference,intent,intent,intent);
        if (previous && !(previous.state==="REJECTED" && previous.reviewed===1)) { action = map(previous); return; }
        const blocked = await tx.getFirstAsync("SELECT action_id FROM cloud_driver_action WHERE shift_reference=? AND (state='PENDING' OR (state='REJECTED' AND reviewed=0)) LIMIT 1",input.shiftReference);
        if (blocked) throw new Error("RECOVER_OR_REVIEW_PRECEDING_ACTION");
        const last = await tx.getFirstAsync<{ seq: number }>("SELECT coalesce(max(sequence),0) AS seq FROM cloud_driver_action WHERE shift_reference=?",input.shiftReference);
        const clientActionId = options.uuid(); const key = `action_${options.uuid()}`; const batchKey = `batch_${options.uuid()}`;
        const request = { deviceSessionId: input.shiftGeneration, shiftReference: input.shiftReference, shiftGeneration: input.shiftGeneration,
          items: [{ ...input.details, clientActionId, deviceEpoch: 1, sequence: Math.max(Number(last?.seq ?? 0),input.serverSequence) + 1, capturedAt: options.now(),
            resourceReference: input.resourceReference, expectedTag: input.expectedTag, command: input.command, idempotencyKey: key }] } as DriverActionBatch;
        await tx.runAsync("INSERT INTO cloud_driver_action(shift_reference,sequence,action_id,intent_key,batch_key,encrypted_request,state) VALUES(?,?,?,?,?,?,'PENDING')",
          input.shiftReference,request.items[0]!.sequence,clientActionId,previous ? `${intent}:reviewed_retry:${clientActionId}` : intent,batchKey,encode(request));
        action = { batchKey, request, state: "PENDING", receipt: null,reviewed:false };
      });
      return action!;
    },
    async reviewRejections(shift: string, serverSequence: number) {
      await db.withExclusiveTransactionAsync(async tx=>{
        if(await tx.getFirstAsync("SELECT action_id FROM cloud_driver_action WHERE shift_reference=? AND state='PENDING' LIMIT 1",shift)) throw new Error("RECOVER_PENDING_BEFORE_REVIEW");
        if(await tx.getFirstAsync("SELECT action_id FROM cloud_driver_action WHERE shift_reference=? AND sequence>? LIMIT 1",shift,serverSequence)) throw new Error("SERVER_SEQUENCE_REVIEW_REQUIRED");
        await tx.runAsync("UPDATE cloud_driver_action SET reviewed=1 WHERE shift_reference=? AND state='REJECTED'",shift);
      });
    },
    async recordAction(action: QueuedAction, receipt: BatchReceipt) {
      if (receipt.items.length !== 1 || receipt.items[0]?.clientItemId !== action.request.items[0]!.clientActionId) throw new Error("ACTION_RECEIPT_IDENTITY_CHANGED");
      const state = receipt.items[0].outcome === "REJECTED" ? "REJECTED" : "ACCEPTED";
      const result = await db.runAsync("UPDATE cloud_driver_action SET encrypted_receipt=?,state=? WHERE batch_key=? AND encrypted_request=? AND state='PENDING'",encode(receipt),state,action.batchKey,encode(action.request));
      if (result.changes) return;
      const row = await db.getFirstAsync<Parameters<typeof map>[0]>("SELECT * FROM cloud_driver_action WHERE batch_key=?",action.batchKey);
      if (row && map(row).state === state && JSON.stringify(map(row).receipt) === JSON.stringify(receipt)) return;
      throw new Error("ACTION_COMMAND_IDENTITY_CHANGED");
    },
  };
}
