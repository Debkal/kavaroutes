import { createHash,randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { Type,type Static } from "typebox";
import { createPostgresPersistence,PersistenceConflict,type JsonValue,type StoredMutationResult } from "@kavaroutes/postgres-persistence";
import { ProtocolError,requestFingerprint } from "./protocol.js";
import type { SyntheticPrincipal } from "./security.js";
const closed = { additionalProperties: false };const id = () => Type.String({ format: "uuid" });
export const DriverSignatureRequestSchema = Type.Object({
  shiftGeneration: id(),evidenceId: id(),expectedTag: Type.String({ pattern: '^"kr1\\.[A-Za-z0-9_-]{43}"$' }),
  event: Type.Union([Type.Literal("PICKUP_ATTESTATION"),Type.Literal("DROPOFF_ATTESTATION")]),
  attestationPolicyVersion: Type.Literal("attestation-synthetic-v2"),policyVersion: Type.Integer({ minimum: 1 }),policyDigest: Type.String({ pattern: "^[a-f0-9]{64}$" }),
  capturedAt: Type.String({ format: "date-time" }),localActionAt: Type.String({ format: "date-time" }),
  installationGeneration: Type.String({ pattern: "^inst_[a-z0-9]{16,64}$" }),parkedAttestation: Type.Literal(true),
  role: Type.Union([Type.Literal("RIDER"),Type.Literal("GUARDIAN_OR_AUTHORIZED_REPRESENTATIVE"),Type.Literal("FACILITY_EMPLOYEE"),Type.Literal("DRIVER"),Type.Literal("RIDER_UNABLE_TO_SIGN")]),
  points: Type.Array(Type.Tuple([Type.Integer({ minimum: 0,maximum: 2048 }),Type.Integer({ minimum: 0,maximum: 1024 })]),{ maxItems: 600 }),
  unableReason: Type.Optional(Type.Union([Type.Literal("DECLINED"),Type.Literal("PHYSICALLY_UNABLE"),Type.Literal("NO_AUTHORIZED_SIGNER")])),
  witnessAttestation: Type.Optional(Type.String({ minLength: 2,maxLength: 128 })),supersedesEvidenceId: Type.Optional(id()),
  digest: Type.String({ pattern: "^[a-f0-9]{64}$" }),
},{ ...closed,$id: "DriverSignatureRequest",title: "DriverSignatureRequest" });
export const DriverSignatureReceiptSchema = Type.Object({ evidenceId: id(),shiftReference: id(),tripLegId: id(),event: Type.Union([Type.Literal("PICKUP_ATTESTATION"),Type.Literal("DROPOFF_ATTESTATION")]),
  status: Type.Literal("ACCEPTED_FOR_SERVICE_CONTROL"),resourceVersion: Type.Integer({ minimum: 1 }),digest: Type.String({ pattern: "^[a-f0-9]{64}$" }) },{ ...closed,$id: "DriverSignatureReceipt",title: "DriverSignatureReceipt" });
export type DriverSignatureRequest = Static<typeof DriverSignatureRequestSchema>;export type DriverSignatureReceipt = Static<typeof DriverSignatureReceiptSchema>;
export function signatureDigestInput(shiftId: string,legId: string,request: Omit<DriverSignatureRequest,"digest">) {
  return JSON.stringify({ shiftReference: shiftId,tripLegId: legId,shiftGeneration: request.shiftGeneration,evidenceId: request.evidenceId,
    expectedTag: request.expectedTag,event: request.event,attestationPolicyVersion: request.attestationPolicyVersion,
    policyVersion: request.policyVersion,policyDigest: request.policyDigest,capturedAt: request.capturedAt,localActionAt: request.localActionAt,
    installationGeneration: request.installationGeneration,parkedAttestation: request.parkedAttestation,role: request.role,points: request.points,
    ...(request.unableReason ? { unableReason: request.unableReason } : {}),...(request.witnessAttestation ? { witnessAttestation: request.witnessAttestation } : {}),
    ...(request.supersedesEvidenceId ? { supersedesEvidenceId: request.supersedesEvidenceId } : {}) });
}
export type ProofRule = { pickupRequired: boolean;dropoffRequired: boolean;mobilitySecurementRequired: boolean;allowedRoles: string[];unableReasons: string[];noShowWaitMinutes: number;noShowAllowed: boolean;noShowAuthorizationReference: string | null };
export function validateProofRule(value: unknown): ProofRule {
  const r = value as ProofRule;
  if (!r || Object.keys(r).sort().join() !== "allowedRoles,dropoffRequired,mobilitySecurementRequired,noShowAllowed,noShowAuthorizationReference,noShowWaitMinutes,pickupRequired,unableReasons" ||
    typeof r.pickupRequired !== "boolean" || typeof r.dropoffRequired !== "boolean" || typeof r.noShowAllowed !== "boolean" ||
    typeof r.mobilitySecurementRequired !== "boolean" || (r.noShowAuthorizationReference !== null && !/^[a-f0-9-]{36}$/.test(r.noShowAuthorizationReference)) || r.noShowAllowed && !r.noShowAuthorizationReference ||
    !Number.isInteger(r.noShowWaitMinutes) || r.noShowWaitMinutes < 1 || r.noShowWaitMinutes > 120 ||
    !Array.isArray(r.allowedRoles) || !r.allowedRoles.length || r.allowedRoles.some(v=>!["RIDER","GUARDIAN_OR_AUTHORIZED_REPRESENTATIVE","FACILITY_EMPLOYEE","DRIVER","RIDER_UNABLE_TO_SIGN"].includes(v)) ||
    !Array.isArray(r.unableReasons) || r.unableReasons.some(v=>!["DECLINED","PHYSICALLY_UNABLE","NO_AUTHORIZED_SIGNER"].includes(v))) throw new Error("PROOF_POLICY_STORAGE_INVALID");
  return r;
}
export interface DriverSignatureService { submit(input: { organizationId: string;shiftId: string;legId: string;principal: SyntheticPrincipal;key: string;request: DriverSignatureRequest }): Promise<StoredMutationResult<DriverSignatureReceipt>> }
export function createPostgresDriverSignatureService(pool: Pool,options: { etag(id: string,version: number,projection: string): string;now?: ()=>Date }): DriverSignatureService {
  const persistence = createPostgresPersistence(pool);const now = options.now ?? (()=>new Date());
  return { async submit(input) {
    const { request } = input;const driverId = input.principal.subjectId;
    if (!driverId || input.principal.organizationId !== input.organizationId || !input.principal.capabilities.has("driver:execute") || !input.principal.purposes.has("ASSIGNED_SERVICE_DELIVERY")) throw new ProtocolError(404,"RESOURCE_NOT_FOUND","resource hidden");
    return persistence.executeIdempotentMutation({ tenantId: input.organizationId,actorReference: input.principal.id,operationId: "submitDriverSignature",key: input.key,
      fingerprint: requestFingerprint({ shiftId: input.shiftId,legId: input.legId,request }),recordId: randomUUID(),expiresAt: new Date(now().getTime()+86_700_000),isolationLevel: "serializable" },async tx=>{
      const shift = await tx.lockDriverActionShift({ shiftId: input.shiftId,driverId });
      if (!shift || shift.shiftGeneration !== request.shiftGeneration) throw new ProtocolError(404,"RESOURCE_NOT_FOUND","resource hidden");
      if (shift.lifecycle !== "ACTIVE") throw new ProtocolError(409,"DRIVER_SHIFT_NOT_ACTIVE","review required");
      const execution = await tx.readDriverLegExecution({ shiftId: input.shiftId,tripLegId: input.legId });
      if (!execution) throw new ProtocolError(404,"RESOURCE_NOT_FOUND","resource hidden");
      if (options.etag(execution.executionId,execution.version,"driver-execution-v1") !== request.expectedTag) throw new PersistenceConflict("stale-version","stale execution");
      const control = await tx.readDriverServiceControl(input.shiftId,input.legId);
      if (!control?.rule) throw new ProtocolError(409,"PROOF_POLICY_REQUIRED","explicit proof rule missing");
      if (control.incidentOpen) throw new ProtocolError(409,"INCIDENT_REQUIRES_DISPATCH_REVIEW","incident requires review");
      const rule = validateProofRule(control.rule.rule);
      if (request.policyVersion !== control.rule.version || request.policyDigest !== control.rule.digest) throw new ProtocolError(422,"PROOF_POLICY_MISMATCH","proof rule mismatch");
      if (request.event === "PICKUP_ATTESTATION" ? execution.lifecycle !== "ARRIVED_PICKUP" || !control.riderVerified || !control.boardingSecure : execution.lifecycle !== "ARRIVED_DROPOFF" || !control.safelyUnloaded) throw new ProtocolError(409,"SERVICE_PROOF_ORDER_REQUIRED","complete physical controls first");
      if (!rule.allowedRoles.includes(request.role)) throw new ProtocolError(422,"SIGNER_ROLE_NOT_ALLOWED","signer role unavailable");
      if (request.role === "RIDER_UNABLE_TO_SIGN") {
        if (request.points.length || !request.unableReason || !rule.unableReasons.includes(request.unableReason) || !request.witnessAttestation?.trim()) throw new ProtocolError(422,"SIGNATURE_EXCEPTION_NOT_ALLOWED","documented exception required");
      } else {
        if (request.unableReason || request.witnessAttestation || request.points.length<8) throw new ProtocolError(422,"SIGNATURE_STROKE_INVALID","draw a fuller mark");
        let distance=0;for(let i=1;i<request.points.length;i++) distance+=Math.hypot(request.points[i]![0]-request.points[i-1]![0],request.points[i]![1]-request.points[i-1]![1]);
        const xs=request.points.map(p=>p[0]),ys=request.points.map(p=>p[1]);
        if(distance<40 || Math.max(...xs)-Math.min(...xs)<20 && Math.max(...ys)-Math.min(...ys)<20) throw new ProtocolError(422,"SIGNATURE_STROKE_INVALID","draw a fuller mark");
      }
      const raw=signatureDigestInput(input.shiftId,input.legId,request);const digest=createHash("sha256").update(`SIGNATURE:${raw}`).digest("hex");
      if(digest!==request.digest) throw new ProtocolError(422,"SIGNATURE_DIGEST_MISMATCH","signature binding mismatch");
      // A repeated attestation is a replay of work the server already holds, not an
      // error: an interrupted submit that committed on the server must answer with the
      // stored receipt so the client stops showing "internal error" (audit WEB-A-022).
      const recorded=await tx.readActiveDriverServiceProof({shiftId:input.shiftId,tripLegId:input.legId,event:request.event});
      if(recorded){
        if(recorded.digest===digest){
          const current=await tx.readDriverLegExecution({shiftId:input.shiftId,tripLegId:input.legId});
          return { statusCode: 200,body: { evidenceId: recorded.evidenceId,shiftReference: input.shiftId,tripLegId: input.legId,event: request.event,status: "ACCEPTED_FOR_SERVICE_CONTROL" as const,resourceVersion: current?.version ?? execution.version,digest: recorded.digest },headers: {},resultReference: recorded.evidenceId };
        }
        // An explicit supersession stays available: it replaces the active proof and is
        // validated against it by the persistence layer, so a re-drawn mark is not
        // mistaken for a duplicate (the gated Postgres proof test exercises this).
        if(!request.supersedesEvidenceId) throw new ProtocolError(409,"SIGNATURE_ALREADY_RECORDED","a different signature is already recorded for this event");
      }
      const strokeOwner=request.points.length ? await tx.strokeDigestOwner({strokeDigest:createHash("sha256").update(JSON.stringify(request.points)).digest("hex"),evidenceId:request.evidenceId}) : null;
      if(strokeOwner) throw new ProtocolError(409,"SIGNATURE_STROKE_REUSED","this signature mark was already used on another proof; draw a different mark");
      await tx.appendDriverServiceProof({ shiftId: input.shiftId,tripLegId: input.legId,evidenceId: request.evidenceId,event: request.event,policyVersion: request.policyVersion,
        policyDigest: request.policyDigest,digest,strokeDigest: request.points.length ? createHash("sha256").update(JSON.stringify(request.points)).digest("hex") : null,
        role: request.role,unsignedPayload: JSON.parse(raw) as JsonValue,...(request.supersedesEvidenceId ? { supersedesEvidenceId: request.supersedesEvidenceId } : {}) });
      const version=await tx.updateDriverLegExecution({ shiftId: input.shiftId,tripLegId: input.legId,executionId: execution.executionId,expectedVersion: execution.version,expectedLifecycle: execution.lifecycle,lifecycle: execution.lifecycle,occurredAt: now() });
      const aggregateVersion=await tx.advanceDriverShiftVersion(input.shiftId,shift.version);const messageId=randomUUID();const occurredAt=now();const retainUntil=new Date(occurredAt.getTime()+2_592_000_000);
      await tx.appendAudit({ auditId: randomUUID(),aggregateKind: "driver-shift",aggregateId: input.shiftId,aggregateVersion,actionReference: "driver.evidence.accepted_for_service_control",actorReference: input.principal.id });
      await tx.appendOutboxMessage({ messageId,eventId: randomUUID(),aggregateType: "DRIVER_SHIFT",aggregateId: input.shiftId,aggregateVersion,eventType: "DriverActionRecorded",schemaVersion: "v1",occurredAt,commandId: request.evidenceId,idempotencyReferenceHash: digest,
        correlationId: randomUUID(),source: "kavaroutes.api",classificationReference: "OPERATIONAL_SENSITIVE",purposeReference: "ASSIGNED_SERVICE_DELIVERY",policyReference: "privacy-synthetic-v1",payload: { shiftReference: input.shiftId,driverId,assignmentId: shift.assignmentId,policyDigest: shift.policyDigest },retainUntil });
      await tx.appendOutboxDelivery({ deliveryId: randomUUID(),messageId,route: "realtime-signal",jobType: "kr.realtime-signal.driver-shift.v1",availableAt: occurredAt,retainUntil });
      return { statusCode: 200,body: { evidenceId: request.evidenceId,shiftReference: input.shiftId,tripLegId: input.legId,event: request.event,status: "ACCEPTED_FOR_SERVICE_CONTROL" as const,resourceVersion: version,digest },headers: {},resultReference: request.evidenceId };
    }).catch((error: unknown) => {
      // A concurrent submit aborts the serializable transaction; that is a retryable
      // state conflict, not an internal fault (audit WEB-A-022).
      if (error && typeof error === "object" && "code" in error && ["40001","40P01"].includes(String((error as {code?:unknown}).code))) {
        throw new PersistenceConflict("stale-version","concurrent signature submit requires a re-read");
      }
      throw error;
    });
  } };
}
