import type { DriverPrecheckRequest, DriverPrecheckReceipt } from "@kavaroutes/api-contracts/client-web";
import type { SQLiteDatabase } from "expo-sqlite";

type SavedCommand = { key: string; request: DriverPrecheckRequest; receipt: DriverPrecheckReceipt | null; state: "PENDING" | "ACCEPTED" | "REJECTED" };
const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

// This adapter only runs on the already keyed, authenticated SQLCipher database.
// Keeping SQL/command identity separate from transport makes lost-response recovery testable.
export function createCloudPrecheckStore(db: Pick<SQLiteDatabase, "getFirstAsync" | "runAsync">,
  options: { newKey(): string; now(): string;stage?:'PRE'|'POST' }) {
  const table=options.stage==='POST'?'cloud_postcheck_command':'cloud_precheck_command';
  const read = async (shiftReference: string): Promise<SavedCommand | null> => {
    const row = await db.getFirstAsync<{ idempotency_key: string; encrypted_request: Uint8Array; encrypted_receipt: Uint8Array | null; state: SavedCommand["state"] }>(
      `SELECT idempotency_key,encrypted_request,encrypted_receipt,state FROM ${table} WHERE shift_reference=?`, shiftReference);
    if (!row) return null;
    return { key: row.idempotency_key, request: JSON.parse(new TextDecoder().decode(row.encrypted_request)) as DriverPrecheckRequest,
      receipt: row.encrypted_receipt ? JSON.parse(new TextDecoder().decode(row.encrypted_receipt)) as DriverPrecheckReceipt : null, state: row.state };
  };
  return {
    read,
    async prepare(shiftReference: string, request: DriverPrecheckRequest) {
      const existing = await read(shiftReference);
      if (existing && existing.state !== "REJECTED") return existing;
      await db.runAsync(`INSERT INTO ${table} (shift_reference,idempotency_key,encrypted_request,state,created_at)
        VALUES (?,?,?,'PENDING',?) ON CONFLICT(shift_reference) DO UPDATE SET idempotency_key=excluded.idempotency_key,
        encrypted_request=excluded.encrypted_request,encrypted_receipt=NULL,state='PENDING',created_at=excluded.created_at
        WHERE ${table}.state='REJECTED'`, shiftReference,options.newKey(),encode(request),options.now());
      const stored = await read(shiftReference);
      if (!stored) throw new Error("PRECHECK_COMMAND_NOT_SAVED");
      return stored;
    },
    async record(shiftReference: string, key: string, receipt: DriverPrecheckReceipt | null) {
      if (receipt && receipt.shiftReference !== shiftReference) throw new Error("PRECHECK_RECEIPT_BINDING_CHANGED");
      const result = await db.runAsync(`UPDATE ${table} SET state=?,encrypted_receipt=?
        WHERE shift_reference=? AND idempotency_key=? AND state='PENDING'`, receipt ? "ACCEPTED" : "REJECTED",
        receipt ? encode(receipt) : null,shiftReference,key);
      if (result.changes === 1) return;
      const stored = await read(shiftReference);
      // Duplicate taps/recovery can observe the same terminal receipt. Never replace it.
      if (stored?.key === key && stored.state === (receipt ? "ACCEPTED" : "REJECTED") &&
        JSON.stringify(stored.receipt) === JSON.stringify(receipt)) return;
      throw new Error("PRECHECK_COMMAND_IDENTITY_CHANGED");
    },
  };
}
