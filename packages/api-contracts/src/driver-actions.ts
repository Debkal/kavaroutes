import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { createPostgresPersistence, PersistenceConflict, type StoredMutationResult } from "@kavaroutes/postgres-persistence";
import type { SyntheticPrincipal } from "./security.js";
import type { BatchReceipt, DriverActionBatch } from "./schemas.js";
import { ProtocolError, requestFingerprint } from "./protocol.js";
import { validateProofRule } from "./driver-service-proof.js";

export interface DriverActionService {
  submit(input: { organizationId: string; principal: SyntheticPrincipal; key: string; request: DriverActionBatch }): Promise<StoredMutationResult<BatchReceipt>>;
}
type Input = Parameters<DriverActionService["submit"]>[0];
type Receipt = BatchReceipt["items"][number];
const transitions = {
  MARK_EN_ROUTE: { from: "DISPATCHED", to: "EN_ROUTE_PICKUP" },
  ARRIVE_PICKUP: { from: "EN_ROUTE_PICKUP", to: "ARRIVED_PICKUP" },
  VERIFY_RIDER: { from: "ARRIVED_PICKUP", to: "ARRIVED_PICKUP" },
  SECURE_RIDER: { from: "ARRIVED_PICKUP", to: "ARRIVED_PICKUP" },
  BOARD_RIDER: { from: "ARRIVED_PICKUP", to: "ONBOARD" },
  ARRIVE_DROPOFF: { from: "ONBOARD", to: "ARRIVED_DROPOFF" },
  UNLOAD_RIDER: { from: "ARRIVED_DROPOFF", to: "ARRIVED_DROPOFF" },
  COMPLETE_LEG: { from: "ARRIVED_DROPOFF", to: "COMPLETED" },
  REPORT_INCIDENT: { from: "ANY_ACTIVE", to: "SAME_OR_INTERRUPTED" },
  MARK_RIDER_NO_SHOW: { from: "ARRIVED_PICKUP", to: "RIDER_NO_SHOW" },
  REQUEST_CANCEL_LEG: { from: "PRE_BOARDING", to: "SAME" },
} as const;

/** Explicit lifecycle/service-control commands. No local or GPS-created acceptance. */
export function createPostgresDriverActionService(pool: Pool, options: {
  etag: (id: string, version: number, projection: string) => string;
  now?: () => Date;
}): DriverActionService {
  const persistence = createPostgresPersistence(pool);
  const now = options.now ?? (() => new Date());
  return Object.freeze({
    async submit(input: Input) {
      const { shiftReference: shiftId, shiftGeneration } = input.request;
      const driverId = input.principal.subjectId;
      if (input.principal.organizationId !== input.organizationId || !driverId || !input.principal.capabilities.has("driver:execute") ||
        !input.principal.purposes.has("ASSIGNED_SERVICE_DELIVERY")) throw new ProtocolError(404, "RESOURCE_NOT_FOUND", "resource hidden");
      if (!shiftId || !shiftGeneration) throw new ProtocolError(422, "DRIVER_SHIFT_BINDING_REQUIRED", "shift binding required");
      // Unsupported operations stay retryable, without permanently rejecting a future supported command.
      if (input.request.items.some(item => !Object.hasOwn(transitions, item.command))) throw new ProtocolError(503, "DRIVER_COMMAND_NOT_PROMOTED", "command service unavailable");
      const fingerprint = requestFingerprint(input.request);
      return persistence.executeIdempotentMutation({ tenantId: input.organizationId, actorReference: input.principal.id,
        operationId: "submitDriverActionBatch", key: input.key, fingerprint, recordId: randomUUID(),
        expiresAt: new Date(now().getTime() + 86_700_000), isolationLevel: "serializable" }, async tx => {
        const shift = await tx.lockDriverActionShift({ shiftId, driverId });
        if (!shift || shift.shiftGeneration !== shiftGeneration) throw new ProtocolError(404, "RESOURCE_NOT_FOUND", "resource hidden");
        const policy = shift.effectivePolicy as unknown as { preInspection?: { mode?: string }; startOdometer?: { mode?: string } };
        // All enabled controls require their actual persisted decision; optional is not completion.
        const modes = [policy.preInspection?.mode, policy.startOdometer?.mode];
        if (modes.some(mode => !["DISABLED", "OPTIONAL", "REQUIRED"].includes(mode ?? ""))) throw new Error("DRIVER_POLICY_STORAGE_INVALID");
        let lastSequence = shift.lastSequence;
        let shiftVersion = shift.version;
        let dependentRejection = false;
        const items: Receipt[] = [];
        for (const item of input.request.items) {
          const itemFingerprint = requestFingerprint({ shiftId, shiftGeneration, item });
          const previous = await tx.readDriverActionReceipt({ shiftId, clientActionId: item.clientActionId, idempotencyKey: item.idempotencyKey });
          if (previous) {
            if (previous.clientActionId !== item.clientActionId || previous.idempotencyKey !== item.idempotencyKey ||
              previous.fingerprint !== itemFingerprint || previous.sequence !== item.sequence) {
              throw new PersistenceConflict("idempotency-mismatch", "driver action identity differs");
            }
            const rejected = previous.outcome === "REJECTED";
            dependentRejection ||= rejected;
            items.push(rejected ? { clientItemId: item.clientActionId, outcome: "REJECTED", code: previous.reasonCode! }
              : { clientItemId: item.clientActionId, outcome: "REPLAYED", resourceVersion: previous.resourceVersion! });
            continue;
          }
          if (item.sequence !== lastSequence + 1) throw new ProtocolError(409, "DRIVER_ACTION_SEQUENCE_GAP", "recover preceding action receipts");
          let code: string | undefined;
          let version: number | undefined;
          const transition = transitions[item.command as keyof typeof transitions];
          const execution = await tx.readDriverLegExecution({ shiftId, tripLegId: item.resourceReference });
          const precheck = await tx.readDriverPrecheck(shiftId);
          const control = execution ? await tx.readDriverServiceControl(shiftId,item.resourceReference) : null;
          const proofRule = control?.rule ? validateProofRule(control.rule.rule) : null;
          const anyActive = execution && ["DISPATCHED","EN_ROUTE_PICKUP","ARRIVED_PICKUP","ONBOARD","ARRIVED_DROPOFF"].includes(execution.lifecycle);
          const preBoarding = execution && ["DISPATCHED","EN_ROUTE_PICKUP","ARRIVED_PICKUP"].includes(execution.lifecycle);
          if (dependentRejection) code = "DEPENDENCY_REJECTED";
          else if (shift.lifecycle !== "ACTIVE") code = "DRIVER_SHIFT_NOT_ACTIVE";
          else if (!execution) code = "RESOURCE_NOT_FOUND";
          else if (options.etag(execution.executionId, execution.version, "driver-execution-v1") !== item.expectedTag) code = "PRECONDITION_FAILED";
          else if (transition.from === "ANY_ACTIVE" ? !anyActive : transition.from === "PRE_BOARDING" ? !preBoarding : execution.lifecycle !== transition.from) code = "LEG_EXECUTION_TRANSITION_NOT_DECLARED";
          else if (precheck?.vehicleState === "BLOCKED_CRITICAL_DEFECT" || shift.vehicleId && await tx.hasUnresolvedCriticalVehicleDefect(shiftId, shift.vehicleId)) code = "CRITICAL_DEFECT_BLOCKS_RELEASE";
          else if (precheck && precheck.vehicleId !== shift.vehicleId) code = "ASSIGNED_VEHICLE_MISMATCH";
          else if (!precheck && modes.includes("REQUIRED")) code = "PRECHECK_REQUIRED";
          else if (!precheck && modes.includes("OPTIONAL")) code = "PRECHECK_DECISION_REQUIRED";
          else if (!precheck) code = "VEHICLE_CONFIRMATION_REQUIRED";
          else if (control?.incidentOpen) code = "INCIDENT_REQUIRES_DISPATCH_REVIEW";
          else if (!["MARK_EN_ROUTE","ARRIVE_PICKUP","REPORT_INCIDENT","REQUEST_CANCEL_LEG"].includes(item.command) && !proofRule) code = "PROOF_POLICY_REQUIRED";
          else if (item.command === "SECURE_RIDER" && !control?.riderVerified) code = "RIDER_VERIFICATION_REQUIRED";
          else if (item.command === "SECURE_RIDER" && proofRule?.mobilitySecurementRequired && item.mobilityDevice !== "SECURED") code = "MOBILITY_SECUREMENT_REQUIRED";
          else if (item.command === "BOARD_RIDER" && (!control?.riderVerified || !control.boardingSecure)) code = "BOARDING_CONTROLS_REQUIRED";
          else if (item.command === "BOARD_RIDER" && proofRule?.pickupRequired && !control?.pickupProof) code = "PICKUP_PROOF_REQUIRED";
          else if (item.command === "COMPLETE_LEG" && !control?.safelyUnloaded) code = "SAFE_UNLOAD_REQUIRED";
          else if (item.command === "COMPLETE_LEG" && (proofRule?.pickupRequired && !control?.pickupProof || proofRule?.dropoffRequired && !control?.dropoffProof)) code = "SERVICE_PROOF_REQUIRED";
          else if (item.command === "MARK_RIDER_NO_SHOW" && (!proofRule?.noShowAllowed || proofRule.noShowAuthorizationReference !== item.authorizationReference || !control?.pickupArrivedAt || now().getTime()-control.pickupArrivedAt.getTime()<proofRule.noShowWaitMinutes*60000 || control.boardingSecure)) code = "NO_SHOW_POLICY_EVIDENCE_REQUIRED";
          else {
            if(item.command==="VERIFY_RIDER") await tx.updateDriverServiceControl(shiftId,item.resourceReference,"rider_verified");
            if(item.command==="SECURE_RIDER") await tx.updateDriverServiceControl(shiftId,item.resourceReference,"boarding_secure");
            if(item.command==="UNLOAD_RIDER") await tx.updateDriverServiceControl(shiftId,item.resourceReference,"safely_unloaded");
            if(item.command==="ARRIVE_PICKUP") await tx.recordDriverPickupArrival(shiftId,item.resourceReference,now());
            if(item.command==="REPORT_INCIDENT") {
              await tx.appendDriverLegException({ shiftId,tripLegId: item.resourceReference,actionId: item.clientActionId,kind: "INCIDENT",documentation: { incidentKind: item.incidentKind,note: item.note } });
              await tx.updateDriverServiceControl(shiftId,item.resourceReference,"incident_open");
            }
            if(item.command==="MARK_RIDER_NO_SHOW") await tx.appendDriverLegException({ shiftId,tripLegId: item.resourceReference,actionId: item.clientActionId,kind: "RIDER_NO_SHOW",documentation: { contactAttestation: item.contactAttestation,authorizationReference: item.authorizationReference,waitMinutes: proofRule!.noShowWaitMinutes } });
            if(item.command==="REQUEST_CANCEL_LEG") await tx.appendDriverLegException({ shiftId,tripLegId: item.resourceReference,actionId: item.clientActionId,kind: "CANCEL_REQUEST",documentation: { reason: item.reason } });
            const nextLifecycle=transition.to==="SAME" ? execution.lifecycle : transition.to==="SAME_OR_INTERRUPTED" ? execution.lifecycle==="ONBOARD" ? "INTERRUPTED" : execution.lifecycle : transition.to;
            version = await tx.updateDriverLegExecution({ shiftId, tripLegId: item.resourceReference,
              executionId: execution.executionId, expectedVersion: execution.version, expectedLifecycle: execution.lifecycle,lifecycle: nextLifecycle, occurredAt: now() });
          }
          const outcome = code ? "REJECTED" as const : "APPLIED" as const;
          await tx.appendDriverActionReceipt({ shiftId, clientActionId: item.clientActionId, sequence: item.sequence,
            idempotencyKey: item.idempotencyKey, fingerprint: itemFingerprint, command: item.command,
            resourceReference: item.resourceReference, outcome, resourceVersion: version ?? null, reasonCode: code ?? null,
            capturedAt: new Date(item.capturedAt) });
          const occurredAt = now(); const messageId = randomUUID();
          const aggregateVersion = await tx.advanceDriverShiftVersion(shiftId, shiftVersion);
          shiftVersion = aggregateVersion;
          await tx.appendAudit({ auditId: randomUUID(), aggregateKind: "driver-shift", aggregateId: shiftId, aggregateVersion,
            actionReference: code ? "driver.action.rejected" : "driver.action.applied", actorReference: input.principal.id });
          await tx.appendOutboxMessage({ messageId, eventId: randomUUID(), aggregateType: "DRIVER_SHIFT", aggregateId: shiftId,
            aggregateVersion, eventType: "DriverActionRecorded", schemaVersion: "v1", occurredAt, commandId: item.clientActionId,
            idempotencyReferenceHash: itemFingerprint, correlationId: randomUUID(), source: "kavaroutes.api",
            classificationReference: "OPERATIONAL_SENSITIVE", purposeReference: "ASSIGNED_SERVICE_DELIVERY", policyReference: "privacy-synthetic-v1",
            payload: { shiftReference: shiftId, driverId, assignmentId: shift.assignmentId, policyDigest: shift.policyDigest },
            retainUntil: new Date(occurredAt.getTime() + 2_592_000_000) });
          await tx.appendOutboxDelivery({ deliveryId: randomUUID(), messageId, route: "realtime-signal",
            jobType: "kr.realtime-signal.driver-shift.v1", availableAt: occurredAt, retainUntil: new Date(occurredAt.getTime() + 2_592_000_000) });
          items.push(code ? { clientItemId: item.clientActionId, outcome, code } : { clientItemId: item.clientActionId, outcome, resourceVersion: version! });
          lastSequence = item.sequence;
          dependentRejection ||= Boolean(code);
        }
        const batchReference = randomUUID();
        return { statusCode: 200, body: { batchReference, items }, headers: {}, resultReference: batchReference };
      });
    },
  });
}
