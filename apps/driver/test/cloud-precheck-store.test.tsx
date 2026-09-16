import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DRIVER_MIGRATIONS } from "../../../packages/driver-core/src/migrations";
import { createCloudPrecheckStore } from "../src/cloud-precheck-store";
import { createInspectionFormStore } from "../src/inspection-form-store";

test("persisted SQL queue keeps the original body/key across reopen, duplicate taps and unknown response", async () => {
  const directory = mkdtempSync(join(tmpdir(), "kavaroutes-precheck-"));
  let database = new DatabaseSync(join(directory, "synthetic.sqlite"));
  try {
    for (const migration of DRIVER_MIGRATIONS) database.exec(migration.sql);
    let nextKey = 0;
    const adapter = () => ({
      getFirstAsync: async (sql: string, ...params: any[]) => database.prepare(sql).get(...params) ?? null,
      runAsync: async (sql: string, ...params: any[]) => database.prepare(sql).run(...params),
    } as any);
    const create = () => createCloudPrecheckStore(adapter(), { newKey: () => `test-key-${++nextKey}`, now: () => "2026-09-14T12:00:00Z" });
    const binding = { generation: "shift-generation", stage: "PRE" as const, policyDigest: "a".repeat(64) };
    const draft = { index: 2, odometer: "1042", fuel: "FULL" as const, defect: true, severity: "MINOR" as const, note: "Unfinished synthetic note",
      skipInspection: false, skipOdometer: true, photoDigest: "b".repeat(64), photoException: null };
    await createInspectionFormStore(adapter()).save(binding, draft);
    const request = { shiftGeneration: "synthetic-generation", capturedAt: "2026-09-14T12:00:00Z", photos: [], expectedVersion: 1 } as any;
    let store = create();
    const [first, duplicate] = await Promise.all([store.prepare("shift-one", request), store.prepare("shift-one", { ...request, expectedVersion: 999 })]);
    expect(duplicate).toEqual(first);
    database.close(); database = new DatabaseSync(join(directory, "synthetic.sqlite")); store = create();
    expect(await createInspectionFormStore(adapter()).read(binding)).toEqual(draft);
    await expect(createInspectionFormStore(adapter()).read({ ...binding, policyDigest: "c".repeat(64) })).rejects.toThrow("POLICY_CHANGED");
    expect(await store.read("shift-one")).toEqual(first);
    expect(await store.prepare("shift-one", { ...request, capturedAt: "changed" })).toEqual(first);
    expect((await store.read("shift-one"))?.state).toBe("PENDING");
    const receipt = { shiftReference: "shift-one", resourceVersion: 2, vehicleState: "READY" } as any;
    await Promise.all([store.record("shift-one", first.key, receipt), store.record("shift-one", first.key, receipt)]);
    expect((await store.read("shift-one"))?.receipt).toEqual(receipt);
    await expect(store.record("shift-one", first.key, null)).rejects.toThrow("IDENTITY_CHANGED");
    await expect(store.record("shift-one", "changed-key", receipt)).rejects.toThrow("IDENTITY_CHANGED");
    await expect(store.record("shift-one", first.key, { ...receipt, shiftReference: "other" })).rejects.toThrow("BINDING_CHANGED");
    const rejected = await store.prepare("shift-two", request);
    await store.record("shift-two", rejected.key, null);
    const correction = await store.prepare("shift-two", { ...request, expectedVersion: 2 });
    expect(correction.key).not.toBe(rejected.key); expect(correction.state).toBe("PENDING");
    await expect(store.record("shift-two", rejected.key, null)).rejects.toThrow("IDENTITY_CHANGED");
  } finally { database.close(); rmSync(directory, { recursive: true, force: true }); }
});
