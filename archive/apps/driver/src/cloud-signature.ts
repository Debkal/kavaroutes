import type { DriverSignatureRequest } from "@kavaroutes/api-contracts/client-web";
// Client-safe canonical form; golden-tested against the authoritative server serializer.
export function cloudSignatureDigestInput(shiftId: string,legId: string,r: Omit<DriverSignatureRequest,"digest">) {
  return JSON.stringify({ shiftReference:shiftId,tripLegId:legId,shiftGeneration:r.shiftGeneration,evidenceId:r.evidenceId,
    expectedTag:r.expectedTag,event:r.event,attestationPolicyVersion:r.attestationPolicyVersion,policyVersion:r.policyVersion,policyDigest:r.policyDigest,
    capturedAt:r.capturedAt,localActionAt:r.localActionAt,installationGeneration:r.installationGeneration,parkedAttestation:r.parkedAttestation,role:r.role,points:r.points,
    ...(r.unableReason ? {unableReason:r.unableReason}:{}),...(r.witnessAttestation ? {witnessAttestation:r.witnessAttestation}:{}),...(r.supersedesEvidenceId ? {supersedesEvidenceId:r.supersedesEvidenceId}:{}) });
}
