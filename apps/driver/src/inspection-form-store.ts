import type { SQLiteDatabase } from "expo-sqlite";
import type { DefectSeverity, SyntheticWorkflow } from "@kavaroutes/driver-core";
export type InspectionFormDraft = {
  index: number; odometer: string; fuel: NonNullable<SyntheticWorkflow["fuelLevel"]>;
  defect: boolean; severity: DefectSeverity; note: string; skipInspection: boolean; skipOdometer: boolean;
  photoDigest: string | null; photoException: "UNSAFE_TO_CAPTURE" | "CAMERA_UNAVAILABLE" | null;
};
export type FormBinding = { generation: string; stage: "PRE" | "POST"; policyDigest: string };
export function validateInspectionFormDraft(value: unknown): InspectionFormDraft {
  const d = value as InspectionFormDraft;
  if (!d || typeof d !== "object" || Object.keys(d).sort().join() !== "defect,fuel,index,note,odometer,photoDigest,photoException,severity,skipInspection,skipOdometer" ||
    !Number.isInteger(d.index) || d.index < 0 || d.index >= 20 || typeof d.odometer !== "string" || d.odometer.length > 32 ||
    !["EMPTY", "QUARTER", "HALF", "THREE_QUARTERS", "FULL"].includes(d.fuel) || typeof d.note !== "string" || d.note.length > 2000 ||
    !["CRITICAL_OUT_OF_SERVICE", "SERVICE_AFFECTING", "MINOR"].includes(d.severity) ||
    [d.defect, d.skipInspection, d.skipOdometer].some(v => typeof v !== "boolean") ||
    d.photoDigest !== null && !/^[a-f0-9]{64}$/.test(d.photoDigest) ||
    ![null, "UNSAFE_TO_CAPTURE", "CAMERA_UNAVAILABLE"].includes(d.photoException)) throw new Error("INSPECTION_DRAFT_INVALID");
  return d;
}
export function createInspectionFormStore(db: Pick<SQLiteDatabase, "getFirstAsync" | "runAsync">) {
  return {
    async read(binding: FormBinding) {
      const row = await db.getFirstAsync<{ policy_digest: string; encrypted_draft: Uint8Array }>(
        "SELECT policy_digest,encrypted_draft FROM inspection_form_draft WHERE shift_generation=? AND stage=?", binding.generation,binding.stage);
      if (!row) return null;
      if (row.policy_digest !== binding.policyDigest) throw new Error("INSPECTION_DRAFT_POLICY_CHANGED");
      return validateInspectionFormDraft(JSON.parse(new TextDecoder().decode(row.encrypted_draft)));
    },
    async save(binding: FormBinding, draft: InspectionFormDraft) {
      validateInspectionFormDraft(draft);
      await db.runAsync(`INSERT INTO inspection_form_draft (shift_generation,stage,policy_digest,encrypted_draft)
        VALUES (?,?,?,?) ON CONFLICT(shift_generation,stage) DO UPDATE SET encrypted_draft=excluded.encrypted_draft
        WHERE inspection_form_draft.policy_digest=excluded.policy_digest`, binding.generation,binding.stage,binding.policyDigest,
        new TextEncoder().encode(JSON.stringify(draft)));
    },
  };
}
