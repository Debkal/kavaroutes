import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DRIVER_MIGRATIONS } from "../../../packages/driver-core/src/migrations";
import { createCloudCommandStore } from "../src/cloud-command-store";
test("real SQL cloud queue preserves original start/action identity, sequences, rejection and encrypted projections across reopen", async () => {
  const directory = mkdtempSync(join(tmpdir(), "kavaroutes-cloud-queue-")); let db = new DatabaseSync(join(directory,"synthetic.sqlite"));
  let counter = 0; let tail = Promise.resolve();
  const adapter: any = {
    getFirstAsync: async (sql: string,...params: any[]) => db.prepare(sql).get(...params) ?? null,
    getAllAsync: async (sql: string,...params: any[]) => db.prepare(sql).all(...params),
    runAsync: async (sql: string,...params: any[]) => db.prepare(sql).run(...params),
    withExclusiveTransactionAsync: (fn: (tx: any) => Promise<void>) => { const call = tail.then(async () => {
      db.exec("BEGIN"); try { await fn(adapter); db.exec("COMMIT"); } catch (cause) { db.exec("ROLLBACK"); throw cause; }
    }); tail = call.catch(() => undefined); return call; },
  };
  const create = () => createCloudCommandStore(adapter,{ uuid: () => `60000000-0000-4000-8000-${String(++counter).padStart(12,"0")}`, now: () => "2026-09-14T12:00:00Z" });
  try {
    for (const m of DRIVER_MIGRATIONS) db.exec(m.sql);
    let store = create(); const input = { assignmentId: "original-assignment", assignmentVersion: 1, serviceDate: "2026-09-14" };
    const first = await store.prepareStart(input);
    expect(await store.prepareStart({ ...input, assignmentId: "changed" })).toEqual(first);
    await store.saveManifest({ driverReference: "synthetic-driver",serviceDate: "2026-09-14",legs: [] });
    db.close(); db = new DatabaseSync(join(directory,"synthetic.sqlite")); store = create();
    expect(await store.start()).toEqual(first); expect((await store.manifest())?.serviceDate).toBe("2026-09-14");
    const startReceipt: any = { outcome: "APPLIED", shiftReference: "server-shift", shiftGeneration: "server-generation",resourceVersion: 1 };
    await store.recordStart(first.request.idempotencyKey,startReceipt);
    await store.recordStart(first.request.idempotencyKey,{ ...startReceipt,outcome: "REPLAYED" });
    await expect(store.recordStart(first.request.idempotencyKey,{ ...startReceipt,shiftReference: "different" })).rejects.toThrow("IDENTITY_CHANGED");
    const actionInput = { shiftReference: "server-shift",shiftGeneration: "server-generation",resourceReference: "assigned-leg",expectedTag: '"original-tag"',command: "MARK_EN_ROUTE" as const,serverSequence: 3 };
    const [action, duplicate] = await Promise.all([store.enqueue(actionInput),store.enqueue(actionInput)]);
    expect(duplicate).toEqual(action); expect(action.request.items[0]?.sequence).toBe(4);
    expect(action.request.items[0]?.resourceReference).toBe("assigned-leg");
    await expect(store.enqueue({ ...actionInput, command: "ARRIVE_PICKUP" })).rejects.toThrow("PRECEDING_ACTION");
    db.close(); db = new DatabaseSync(join(directory,"synthetic.sqlite")); store = create();
    expect((await store.actions("server-shift"))[0]).toEqual(action);
    const receipt: any = { batchReference: "batch-reference",items: [{ clientItemId: action.request.items[0]?.clientActionId,outcome: "APPLIED",resourceVersion: 2 }] };
    await store.recordAction(action,receipt); await store.recordAction(action,receipt);
    await expect(store.recordAction(action,{ ...receipt,items: [{ ...receipt.items[0],clientItemId: "other" }] })).rejects.toThrow("IDENTITY_CHANGED");
    const next = await store.enqueue({ ...actionInput,command: "ARRIVE_PICKUP",expectedTag: '"next-tag"',serverSequence: 4 });
    expect(next.request.items[0]?.sequence).toBe(5);
    await store.recordAction(next,{ batchReference: "rejected-batch",items: [{ clientItemId: next.request.items[0]!.clientActionId,outcome: "REJECTED",code: "PRECONDITION_FAILED" }] });
    await expect(store.enqueue({ ...actionInput,expectedTag: '"later-tag"' })).rejects.toThrow("PRECEDING_ACTION");
    expect((await store.actions("server-shift"))[1]?.state).toBe("REJECTED");
    await expect(store.reviewRejections("server-shift",4)).rejects.toThrow("SERVER_SEQUENCE_REVIEW_REQUIRED");
    await store.reviewRejections("server-shift",5);
    const retryInput={...actionInput,command:"ARRIVE_PICKUP" as const,expectedTag:'"next-tag"',serverSequence:5};
    const retry=await store.enqueue(retryInput);expect(retry.request.items[0]?.sequence).toBe(6);
    expect(await store.enqueue(retryInput)).toEqual(retry);
    expect((await store.actions("server-shift"))[1]?.receipt?.items[0]?.outcome).toBe("REJECTED");
    const closure:any={shiftReference:'server-shift',shiftGeneration:'server-generation',lifecycle:'SHIFT_ENDED',collectionStopped:true};
    await expect(store.archiveEndedShift({...closure,lifecycle:'ACTIVE'})).rejects.toThrow('ACCEPTED_SIGN_OFF_REQUIRED');
    await expect(store.archiveEndedShift({...closure,shiftGeneration:'wrong'})).rejects.toThrow('SHIFT_CLOSURE_BINDING_CHANGED');
    await expect(store.archiveEndedShift(closure)).rejects.toThrow('RECOVER_PENDING_BEFORE_NEW_SHIFT');
    expect(await store.start()).not.toBeNull();
    await store.recordAction(retry,{batchReference:'resolved-retry',items:[{clientItemId:retry.request.items[0]!.clientActionId,outcome:'APPLIED',resourceVersion:7}]});
    await store.archiveEndedShift(closure);await store.archiveEndedShift(closure);
    expect(await store.start()).toBeNull();
    expect(db.prepare('SELECT count(*) AS n FROM cloud_shift_history').get()?.n).toBe(1);
    expect((await store.actions('server-shift')).length).toBe(3);
    db.close();db=new DatabaseSync(join(directory,'synthetic.sqlite'));store=create();
    const newShift=await store.prepareStart({...input,assignmentId:'next-assignment'});
    expect(newShift.request.idempotencyKey).not.toBe(first.request.idempotencyKey);
    expect(db.prepare('SELECT command_key FROM cloud_shift_history').get()?.command_key).toBe(first.request.idempotencyKey);
  } finally { db.close(); rmSync(directory,{ recursive: true,force: true }); }
});
