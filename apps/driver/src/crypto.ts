import { CryptoDigestAlgorithm, digestStringAsync } from "expo-crypto";
import { canonicalActionFingerprintInput } from "@kavaroutes/driver-core";

export function createActionFingerprint(value: { readonly resourceReference: string; readonly expectedVersion: number; readonly causalSequence: number; readonly command: string }): Promise<string> {
  return digestStringAsync(CryptoDigestAlgorithm.SHA256, canonicalActionFingerprintInput(value));
}

export function createEvidenceDigest(canonicalSyntheticDraft: string): Promise<string> {
  if (canonicalSyntheticDraft.length < 1 || canonicalSyntheticDraft.length > 65_536) throw new Error("EVIDENCE_DRAFT_SIZE_INVALID");
  return digestStringAsync(CryptoDigestAlgorithm.SHA256, canonicalSyntheticDraft);
}
