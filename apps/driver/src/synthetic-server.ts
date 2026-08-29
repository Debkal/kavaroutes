import { SYNTHETIC_SMALL_BUSINESS_POLICY, type DriverPolicySnapshot } from "@kavaroutes/driver-core";

export interface SyntheticShiftStartReceipt {
  readonly outcome: "ACCEPTED";
  readonly resourceVersion: number;
  readonly effectivePolicy: DriverPolicySnapshot;
}

export async function restoreSyntheticAuthentication(): Promise<"authenticated"> {
  await Promise.resolve();
  return "authenticated";
}

export async function requestSyntheticShiftStartReceipt(expectedVersion: number): Promise<SyntheticShiftStartReceipt> {
  await Promise.resolve();
  if (!Number.isInteger(expectedVersion) || expectedVersion < 1) throw new Error("SYNTHETIC_SHIFT_VERSION_INVALID");
  return Object.freeze({ outcome: "ACCEPTED", resourceVersion: expectedVersion + 1, effectivePolicy: SYNTHETIC_SMALL_BUSINESS_POLICY });
}
