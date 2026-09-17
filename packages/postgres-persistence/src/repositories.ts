import { randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import type { Pool, PoolClient } from "pg";
import { auditEvents, idempotencyRecords, organizations, runs } from "./schema.js";
import {applyDispatchAssignment,releaseDispatchAssignment,type DispatchAssignmentInput,type DispatchReleaseInput,type DispatchReleaseReceipt} from "./dispatch-authority.js";
import {planDispatchRun,type DispatchPlanInput,type DispatchPlanReceipt} from "./dispatch-planning.js";
import {createClientRecord,updateClientRecord,type ClientIntakeInput,type ClientIntakeReceipt,type ClientUpdateInput} from "./client-intake.js";
import {createDriverAccount,createDriverCredential,claimDriverCredential,verifyDriverLogin,type DriverAccountInvite,type DriverCredentialInvite,type DriverCredentialState,type DriverLoginAttempt,type DriverWorkforceRelationship} from "./driver-credentials.js";
import {submitRouteProposal,decideRouteProposal,type RouteProposalInput} from './route-proposals.js';
import {recordSyntheticLocations,closeDriverShift,type SyntheticLocationInput,type ShiftClosureInput} from './shift-closure.js';

export type RuntimeRole = "kavaroutes_api" | "kavaroutes_worker" | "kavaroutes_import" | "kavaroutes_outbox_publisher" | "kavaroutes_outbox_consumer" | "kavaroutes_realtime" | "kavaroutes_push_worker";

export class PersistenceConflict extends Error {
  /** Dispatch refusals name the constraint that fired, so the operator sees which
   * check refused the command instead of one generic assignment failure. Each kind
   * maps to its own problem code in `api-lifecycle.ts`. */
  readonly kind: "stale-version" | "duplicate" | "resource-overlap" | "relationship" | "tenant" | "idempotency-mismatch" | "idempotency-in-progress" | "idempotency-expired"
    | "feasibility" | "qualification" | "vehicle-blocked" | "work-started" | "shift-active" | "leg-window" | "shift-open";
  constructor(kind: PersistenceConflict["kind"], message: string) {
    super(message);
    this.name = "PersistenceConflict";
    this.kind = kind;
  }
}

type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | { readonly [key: string]: JsonValue } | readonly JsonValue[];

export interface StoredMutationResult<T> {
  readonly replayed: boolean;
  readonly statusCode: number;
  readonly body: T;
  readonly headers: Readonly<Record<string, string>>;
}

export interface TenantMutationTransaction {
  recordSyntheticLocations(input:SyntheticLocationInput):ReturnType<typeof recordSyntheticLocations>;
  closeDriverShift(input:ShiftClosureInput):ReturnType<typeof closeDriverShift>;
  assignDispatchRun(input:DispatchAssignmentInput):ReturnType<typeof applyDispatchAssignment>;
  releaseDispatchAssignment(input:DispatchReleaseInput):Promise<DispatchReleaseReceipt>;
  planDispatchRun(input:DispatchPlanInput):Promise<DispatchPlanReceipt>;
  createClientRecord(input:ClientIntakeInput):Promise<ClientIntakeReceipt>;
  updateClientRecord(input:ClientUpdateInput):Promise<ClientIntakeReceipt>;
  createDriverCredential(input:{driverId:string;loginId:string}):Promise<DriverCredentialInvite>;
  createDriverAccount(input:{driverId:string;displayName:string;workforceRelationship:DriverWorkforceRelationship;loginId:string}):Promise<DriverAccountInvite>;
  claimDriverCredential(input:{driverId:string;inviteCode:string;password:string;installation?:string}):Promise<DriverCredentialState>;
  verifyDriverLogin(input:{loginId:string;password:string}):Promise<DriverLoginAttempt>;
  submitRouteProposal(input:RouteProposalInput):ReturnType<typeof submitRouteProposal>;
  decideRouteProposal(input:Parameters<typeof decideRouteProposal>[2]):ReturnType<typeof decideRouteProposal>;
  readDriverPrecheck(shiftId: string,stage?:'PRE'|'POST'): Promise<StoredDriverPrecheck | null>;
  hasUnfinishedDriverLegs(shiftId:string):Promise<boolean>;
  hasUnresolvedCriticalVehicleDefect(shiftId: string, vehicleId: string): Promise<boolean>;
  appendDriverPrecheck(input: StoredDriverPrecheck & { shiftId: string; policyDigest: string; answers: JsonValue;
    capturedAt: Date; photos: readonly { digest: string; content: Uint8Array }[];stage?:'PRE'|'POST' }): Promise<void>;
  advanceDriverShiftVersion(shiftId: string, expectedVersion: number): Promise<number>;
  readDriverLegExecution(input: { shiftId: string; tripLegId: string }): Promise<{
    executionId: string; lifecycle: string; version: number;
  } | null>;
  updateDriverLegExecution(input: { shiftId: string; tripLegId: string; executionId: string;
    expectedVersion: number; expectedLifecycle: string; lifecycle: string; occurredAt: Date }): Promise<number>;
  lockDriverActionShift(input: { shiftId: string; driverId: string }): Promise<{
    assignmentId: string; assignmentVersion: number; vehicleId: string | null; runId: string; runLifecycle: string;
    lifecycle: string; version: number; shiftGeneration: string; policyDigest: string; effectivePolicy: JsonValue; lastSequence: number;
  } | null>;
  readDriverActionReceipt(input: { shiftId: string; clientActionId: string; idempotencyKey: string }): Promise<{
    clientActionId: string; idempotencyKey: string; fingerprint: string; sequence: number;
    outcome: "APPLIED" | "REJECTED"; resourceVersion: number | null; reasonCode: string | null;
  } | null>;
  appendDriverActionReceipt(input: { shiftId: string; clientActionId: string; sequence: number; idempotencyKey: string;
    fingerprint: string; command: string; resourceReference: string; outcome: "APPLIED" | "REJECTED";
    resourceVersion: number | null; reasonCode: string | null; capturedAt: Date }): Promise<void>;
  readDriverServiceControl(shiftId: string,tripLegId: string): Promise<{
    riderVerified: boolean;boardingSecure: boolean;safelyUnloaded: boolean;incidentOpen: boolean;pickupProof: boolean;dropoffProof: boolean;pickupArrivedAt: Date | null;
    rule: { version: number;digest: string;rule: JsonValue } | null;
  } | null>;
  updateDriverServiceControl(shiftId: string,tripLegId: string,field: "rider_verified" | "boarding_secure" | "safely_unloaded" | "incident_open"): Promise<void>;
  recordDriverPickupArrival(shiftId: string,tripLegId: string,occurredAt: Date): Promise<void>;
  appendDriverServiceProof(input: { shiftId: string;tripLegId: string;evidenceId: string;event: string;policyVersion: number;policyDigest: string;digest: string;strokeDigest: string | null;role: string;unsignedPayload: JsonValue;supersedesEvidenceId?: string }): Promise<void>;
  /** The active proof for one event on one leg, if any. Lets a repeated attestation be
   * answered with the stored receipt instead of a conflict (audit WEB-A-022). */
  readActiveDriverServiceProof(input: { shiftId: string;tripLegId: string;event: string }): Promise<{ evidenceId: string; digest: string } | null>;
  /** Whether this stroke digest is already stored for a different evidence id. The
   * anti-replay index is tenant-wide, so the refusal needs its own name. */
  strokeDigestOwner(input: { strokeDigest: string; evidenceId: string }): Promise<string | null>;
  /** The claimed driver login for an id, so a shift start can be bound to it. */
  readDriverCredentialForLogin(input: { loginId: string }): Promise<{ driverId: string; status: string } | null>;
  appendDriverLegException(input: { shiftId: string;tripLegId: string;actionId: string;kind: string;documentation: JsonValue }): Promise<void>;
  readDriverShiftContext(input: { assignmentId: string; driverId: string; serviceDate: string }): Promise<{
    assignmentVersion: number; commercialTier: string; relationship: string; policyVersion: number;
    controls: unknown; locks: unknown; externalFloors: readonly unknown[];
  } | null>;
  pinDriverShift(input: { snapshotId: string; assignmentId: string; assignmentVersion: number; driverId: string; shiftGeneration: string;
    policyVersion: number; policyDigest: string; effectivePolicy: JsonValue }): Promise<void>;
  readTrip(tripId: string): Promise<{ tripId: string; riderId: string; serviceDate: string; serviceTimezone: string; resolvedServiceAt: string; lifecycle: "DRAFT" | "CANCELLED"; version: number } | null>;
  createTripDraft(input: {
    tripId: string; riderId: string; serviceDate: string; serviceTimezone: string; localServiceTime: string;
    resolvedServiceAt: Date; resolvedUtcOffsetSeconds: number; ambiguityPolicy: "reject" | "earlier" | "later";
  }): Promise<{ tripId: string; riderId: string; serviceDate: string; serviceTimezone: string; resolvedServiceAt: string; lifecycle: "DRAFT"; version: number }>;
  updateTripLifecycle(input: { tripId: string; expectedVersion: number; lifecycleReference: "cancelled" }): Promise<{ tripId: string; riderId: string; serviceDate: string; serviceTimezone: string; resolvedServiceAt: string; lifecycle: "CANCELLED"; version: number }>;
  replaceDriverControlPolicy(input: {
    policyId: string; organizationId: string; expectedVersion: number; controls: JsonValue; locks: JsonValue;
    reasonCode: "OWNER_ENABLED_STRICT_PRESET" | "OPERATING_POLICY_CHANGED" | "EXTERNAL_REQUIREMENT_CHANGED"; actorId: string;
  }): Promise<{ policyId: string; version: number }>;
  appendAudit(input: { auditId: string; aggregateKind: string; aggregateId: string; aggregateVersion: number; actionReference: string; actorReference: string }): Promise<void>;
  appendOutboxMessage(input: {
    messageId: string; eventId: string; aggregateType: string; aggregateId: string; aggregateVersion: number;
    eventType: string; schemaVersion: string; occurredAt: Date; commandId: string; idempotencyReferenceHash: string;
    correlationId: string; causationId?: string; source: string; classificationReference: string; purposeReference: string;
    policyReference: string; payload: JsonValue; retainUntil: Date;
  }): Promise<void>;
  appendOutboxDelivery(input: { deliveryId: string; messageId: string; route: string; jobType: string; availableAt: Date; retainUntil: Date }): Promise<void>;
}

export interface StoredDriverPrecheck {
  vehicleId: string;
  version: number;
  inspectionOutcome: "COMPLETED" | "SKIPPED" | "NOT_REQUIRED";
  odometerOutcome: "COMPLETED" | "SKIPPED" | "NOT_REQUIRED";
  vehicleState: "READY" | "BLOCKED_CRITICAL_DEFECT";
  odometer: number | null;
  fuelLevel: string | null;
}

/** A trip row plus the executed state its legs imply. A delivered trip must not read
 * like one that was never executed, and `lifecycle` alone cannot say that: the executed
 * state lives on the leg execution (audit WEB-A-017). */
const tripRecordStateSql = `(SELECT CASE
    WHEN count(e.id)=0 THEN 'DRAFT'
    WHEN count(*) FILTER (WHERE e.lifecycle_reference='completed')=count(e.id) THEN 'DELIVERED'
    WHEN count(*) FILTER (WHERE e.lifecycle_reference NOT IN ('planned','dispatched','completed'))>0 THEN 'IN_PROGRESS'
    ELSE 'PLANNED' END
  FROM intake.trip_leg l LEFT JOIN execution.leg_execution e ON e.tenant_id=l.tenant_id AND e.trip_leg_id=l.id
  WHERE l.tenant_id=t.tenant_id AND l.trip_request_id=t.id)`;
const tripColumns = `t.id,t.rider_id,t.service_date,t.service_timezone,t.resolved_service_at,t.lifecycle_reference,t.aggregate_version,
  CASE WHEN t.lifecycle_reference='cancelled' THEN 'CANCELLED' ELSE ${tripRecordStateSql} END AS record_state`;
function rowToTrip(row: { id: string; rider_id: string; service_date: string | Date; service_timezone: string; resolved_service_at: Date; lifecycle_reference: string; aggregate_version: string; record_state?: string | null }): {
  tripId: string; riderId: string; serviceDate: string; serviceTimezone: string; resolvedServiceAt: string; lifecycle: "DRAFT" | "CANCELLED"; recordState?: string; version: number;
} {
  const serviceDate = row.service_date instanceof Date ? row.service_date.toISOString().slice(0, 10) : row.service_date;
  return {
    tripId: row.id, riderId: row.rider_id, serviceDate, serviceTimezone: row.service_timezone,
    resolvedServiceAt: row.resolved_service_at.toISOString(), lifecycle: row.lifecycle_reference === "cancelled" ? "CANCELLED" : "DRAFT",
    ...(row.record_state ? { recordState: String(row.record_state) } : {}),
    version: Number(row.aggregate_version),
  };
}

function transactionAdapter(client: PoolClient, tenantId: string): TenantMutationTransaction {
  const lockedActionShifts = new Set<string>();
  const lockedExecutions = new Map<string, { executionId: string; lifecycle: string; version: number }>();
  return Object.freeze({
    recordSyntheticLocations:(input:SyntheticLocationInput)=>{if(!lockedActionShifts.has(input.shiftId))throw new Error('DRIVER_SHIFT_LOCK_REQUIRED');return recordSyntheticLocations(client,tenantId,input);},
    closeDriverShift:(input:ShiftClosureInput)=>{if(!lockedActionShifts.has(input.shiftId))throw new Error('DRIVER_SHIFT_LOCK_REQUIRED');return closeDriverShift(client,tenantId,input);},
    assignDispatchRun:(input:DispatchAssignmentInput)=>applyDispatchAssignment(client,tenantId,input),
    releaseDispatchAssignment:(input:DispatchReleaseInput)=>releaseDispatchAssignment(client,tenantId,input),
    planDispatchRun:(input:DispatchPlanInput)=>planDispatchRun(client,tenantId,input),
    createClientRecord:(input:ClientIntakeInput)=>createClientRecord(client,tenantId,input),
    updateClientRecord:(input:ClientUpdateInput)=>updateClientRecord(client,tenantId,input),
    createDriverCredential:(input:{driverId:string;loginId:string})=>createDriverCredential(client,tenantId,input),
    createDriverAccount:(input:{driverId:string;displayName:string;workforceRelationship:DriverWorkforceRelationship;loginId:string})=>createDriverAccount(client,tenantId,input),
    claimDriverCredential:(input:{driverId:string;inviteCode:string;password:string;installation?:string})=>claimDriverCredential(client,tenantId,input),
    verifyDriverLogin:(input:{loginId:string;password:string})=>verifyDriverLogin(client,tenantId,input),
    submitRouteProposal:(input:RouteProposalInput)=>submitRouteProposal(client,tenantId,input),
    decideRouteProposal:(input:Parameters<typeof decideRouteProposal>[2])=>decideRouteProposal(client,tenantId,input),
    async hasUnfinishedDriverLegs(shiftId:string){
      if(!lockedActionShifts.has(shiftId))throw new Error('DRIVER_SHIFT_LOCK_REQUIRED');
      const rows=(await client.query(`SELECT rl.trip_leg_id,t.lifecycle_reference AS trip_state,e.lifecycle_reference,c.incident_open
        FROM execution.shift_policy_snapshot s JOIN dispatch.assignment a ON a.tenant_id=s.tenant_id AND a.id=s.assignment_id
        JOIN dispatch.run_leg rl ON rl.tenant_id=a.tenant_id AND rl.run_id=a.run_id
        JOIN intake.trip_leg l ON l.tenant_id=rl.tenant_id AND l.id=rl.trip_leg_id
        JOIN intake.trip_request t ON t.tenant_id=l.tenant_id AND t.id=l.trip_request_id
        LEFT JOIN execution.leg_execution e ON e.tenant_id=rl.tenant_id AND e.run_id=rl.run_id AND e.trip_leg_id=rl.trip_leg_id
        LEFT JOIN execution.driver_leg_service_control c ON c.tenant_id=e.tenant_id AND c.execution_id=e.id
        WHERE s.tenant_id=$1 AND s.id=$2 FOR UPDATE OF rl,l,t`,[tenantId,shiftId])).rows;
      return !rows.length||new Set(rows.map(r=>r.trip_leg_id)).size!==rows.length||rows.some(r=>r.incident_open||!(['completed','rider_no_show','cancelled'].includes(r.lifecycle_reference)||r.trip_state==='cancelled'&&['planned','dispatched'].includes(r.lifecycle_reference)));
    },
    async hasUnresolvedCriticalVehicleDefect(shiftId: string, vehicleId: string) {
      if (!lockedActionShifts.has(shiftId)) throw new Error("DRIVER_SHIFT_LOCK_REQUIRED");
      // No driver-facing clearance exists. A reviewed dispatch resolution path is separate work.
      const result = await client.query(`SELECT 1 FROM execution.driver_precheck_decision
        WHERE tenant_id=$1 AND vehicle_id=$2 AND vehicle_state='BLOCKED_CRITICAL_DEFECT'
        UNION ALL SELECT 1 FROM execution.driver_postcheck_decision WHERE tenant_id=$1 AND vehicle_id=$2 AND vehicle_state='BLOCKED_CRITICAL_DEFECT' LIMIT 1`, [tenantId,vehicleId]);
      return result.rows.length > 0;
    },
    async readDriverPrecheck(shiftId: string,stage:'PRE'|'POST'='PRE') {
      if (!lockedActionShifts.has(shiftId)) throw new Error("DRIVER_SHIFT_LOCK_REQUIRED");
      const result = await client.query(`SELECT vehicle_id,aggregate_version,inspection_outcome,odometer_outcome,vehicle_state,
        odometer,fuel_level FROM execution.${stage==='POST'?'driver_postcheck_decision':'driver_precheck_decision'} WHERE tenant_id=$1 AND shift_id=$2`, [tenantId,shiftId]);
      const row = result.rows[0]; if (!row) return null;
      return { vehicleId: String(row.vehicle_id), version: Number(row.aggregate_version),
        inspectionOutcome: row.inspection_outcome as StoredDriverPrecheck["inspectionOutcome"],
        odometerOutcome: row.odometer_outcome as StoredDriverPrecheck["odometerOutcome"],
        vehicleState: row.vehicle_state as StoredDriverPrecheck["vehicleState"],
        odometer: row.odometer === null ? null : Number(row.odometer), fuelLevel: row.fuel_level as string | null };
    },
    async appendDriverPrecheck(input: Parameters<TenantMutationTransaction["appendDriverPrecheck"]>[0]) {
      if (!lockedActionShifts.has(input.shiftId)) throw new Error("DRIVER_SHIFT_LOCK_REQUIRED");
      await client.query(`INSERT INTO execution.${input.stage==='POST'?'driver_postcheck_decision':'driver_precheck_decision'}
        (tenant_id,shift_id,vehicle_id,policy_digest,aggregate_version,inspection_outcome,odometer_outcome,vehicle_state,
         odometer,fuel_level,inspection_definition_version,answers,captured_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'inspection-synthetic-v2',$11::jsonb,$12)`,
        [tenantId,input.shiftId,input.vehicleId,input.policyDigest,input.version,input.inspectionOutcome,input.odometerOutcome,
          input.vehicleState,input.odometer,input.fuelLevel,JSON.stringify(input.answers),input.capturedAt]);
      for (const photo of input.photos) await client.query(`INSERT INTO execution.${input.stage==='POST'?'driver_postcheck_photo':'driver_precheck_photo'}
        (tenant_id,shift_id,digest,content) VALUES ($1,$2,$3,$4)`, [tenantId,input.shiftId,photo.digest,Buffer.from(photo.content)]);
    },
    async advanceDriverShiftVersion(shiftId: string, expectedVersion: number) {
      if (!lockedActionShifts.has(shiftId)) throw new Error("DRIVER_SHIFT_LOCK_REQUIRED");
      const result = await client.query(`UPDATE execution.shift_policy_snapshot SET aggregate_version=aggregate_version+1
        WHERE tenant_id=$1 AND id=$2 AND aggregate_version=$3 RETURNING aggregate_version`, [tenantId,shiftId,expectedVersion]);
      if (!result.rows[0]) throw new PersistenceConflict("stale-version", "shift version is stale");
      return Number(result.rows[0].aggregate_version);
    },
    async readDriverLegExecution(input: Parameters<TenantMutationTransaction["readDriverLegExecution"]>[0]) {
      if (!lockedActionShifts.has(input.shiftId)) throw new Error("DRIVER_SHIFT_LOCK_REQUIRED");
      const rows = await client.query(`SELECT e.id,e.lifecycle_reference,e.aggregate_version
        FROM execution.shift_policy_snapshot s
        JOIN dispatch.assignment a ON a.tenant_id=s.tenant_id AND a.id=s.assignment_id AND a.driver_id=s.driver_id
        JOIN dispatch.run r ON r.tenant_id=a.tenant_id AND r.id=a.run_id
        JOIN dispatch.run_leg rl ON rl.tenant_id=r.tenant_id AND rl.run_id=r.id
        JOIN intake.trip_leg l ON l.tenant_id=rl.tenant_id AND l.id=rl.trip_leg_id
        JOIN intake.trip_request t ON t.tenant_id=l.tenant_id AND t.id=l.trip_request_id
        JOIN execution.leg_execution e ON e.tenant_id=l.tenant_id AND e.trip_leg_id=l.id AND e.run_id=r.id
        WHERE s.tenant_id=$1 AND s.id=$2 AND l.id=$3 AND s.lifecycle='ACTIVE'
          AND NOT EXISTS(SELECT 1 FROM dispatch.assignment_supersession su WHERE su.tenant_id=a.tenant_id AND su.prior_assignment_id=a.id)
          AND lower(r.lifecycle_reference) NOT IN ('cancelled','aborted','completed')
          AND lower(t.lifecycle_reference)<>'cancelled'
        FOR UPDATE OF r,rl,l,t,e`, [tenantId,input.shiftId,input.tripLegId]);
      if (rows.rows.length > 1) throw new Error("DRIVER_EXECUTION_AMBIGUOUS");
      const row = rows.rows[0]; if (!row) return null;
      const value = { executionId: String(row.id), lifecycle: String(row.lifecycle_reference).toUpperCase(), version: Number(row.aggregate_version) };
      lockedExecutions.set(`${input.shiftId}:${input.tripLegId}`, value);
      return value;
    },
    async updateDriverLegExecution(input: Parameters<TenantMutationTransaction["updateDriverLegExecution"]>[0]) {
      const locked = lockedExecutions.get(`${input.shiftId}:${input.tripLegId}`);
      if (!locked) throw new Error("DRIVER_EXECUTION_LOCK_REQUIRED");
      if (locked.executionId !== input.executionId || locked.version !== input.expectedVersion || locked.lifecycle !== input.expectedLifecycle) {
        throw new PersistenceConflict("stale-version", "driver execution version is stale");
      }
      const result = await client.query(`UPDATE execution.leg_execution SET lifecycle_reference=$4,
        aggregate_version=aggregate_version+1,occurred_at=$5
        WHERE tenant_id=$1 AND id=$2 AND aggregate_version=$3 AND upper(lifecycle_reference)=$6
        RETURNING aggregate_version`, [tenantId,input.executionId,input.expectedVersion,input.lifecycle.toLowerCase(),input.occurredAt,input.expectedLifecycle]);
      if (!result.rows[0]) throw new PersistenceConflict("stale-version", "driver execution version is stale");
      const version = Number(result.rows[0].aggregate_version);
      lockedExecutions.set(`${input.shiftId}:${input.tripLegId}`, { executionId: input.executionId, lifecycle: input.lifecycle, version });
      return version;
    },
    async readDriverServiceControl(shiftId: string,tripLegId: string) {
      const execution=lockedExecutions.get(`${shiftId}:${tripLegId}`);if(!execution) throw new Error("DRIVER_EXECUTION_LOCK_REQUIRED");
      await client.query("INSERT INTO execution.driver_leg_service_control(tenant_id,execution_id) VALUES($1,$2) ON CONFLICT DO NOTHING",[tenantId,execution.executionId]);
      const result=await client.query(`SELECT c.*,r.policy_version,r.policy_digest,r.rule,
        EXISTS(SELECT 1 FROM execution.driver_service_proof p WHERE p.tenant_id=c.tenant_id AND p.execution_id=c.execution_id AND p.shift_id=$3 AND p.event='PICKUP_ATTESTATION'
          AND p.policy_version=r.policy_version AND p.policy_digest=r.policy_digest AND NOT EXISTS(SELECT 1 FROM execution.driver_proof_supersession s WHERE s.tenant_id=p.tenant_id AND s.supersedes_evidence_id=p.evidence_id)) AS pickup_proof,
        EXISTS(SELECT 1 FROM execution.driver_service_proof p WHERE p.tenant_id=c.tenant_id AND p.execution_id=c.execution_id AND p.shift_id=$3 AND p.event='DROPOFF_ATTESTATION'
          AND p.policy_version=r.policy_version AND p.policy_digest=r.policy_digest AND NOT EXISTS(SELECT 1 FROM execution.driver_proof_supersession s WHERE s.tenant_id=p.tenant_id AND s.supersedes_evidence_id=p.evidence_id)) AS dropoff_proof
        FROM execution.driver_leg_service_control c LEFT JOIN execution.driver_leg_proof_rule r ON r.tenant_id=c.tenant_id AND r.execution_id=c.execution_id
        WHERE c.tenant_id=$1 AND c.execution_id=$2 FOR UPDATE OF c`,[tenantId,execution.executionId,shiftId]);
      const row=result.rows[0];if(!row) return null;
      return { riderVerified: row.rider_verified,boardingSecure: row.boarding_secure,safelyUnloaded: row.safely_unloaded,incidentOpen: row.incident_open,pickupProof: row.pickup_proof,dropoffProof: row.dropoff_proof,pickupArrivedAt: row.pickup_arrived_at as Date | null,
        rule: row.policy_version===null ? null : { version: Number(row.policy_version),digest: String(row.policy_digest),rule: row.rule as JsonValue } };
    },
    async updateDriverServiceControl(shiftId: string,tripLegId: string,field: "rider_verified" | "boarding_secure" | "safely_unloaded" | "incident_open") {
      const execution=lockedExecutions.get(`${shiftId}:${tripLegId}`);if(!execution) throw new Error("DRIVER_EXECUTION_LOCK_REQUIRED");
      if(!["rider_verified","boarding_secure","safely_unloaded","incident_open"].includes(field)) throw new Error("SERVICE_CONTROL_FIELD_INVALID");
      await client.query(`UPDATE execution.driver_leg_service_control SET ${field}=true WHERE tenant_id=$1 AND execution_id=$2`,[tenantId,execution.executionId]);
    },
    async recordDriverPickupArrival(shiftId: string,tripLegId: string,occurredAt: Date) {
      const execution=lockedExecutions.get(`${shiftId}:${tripLegId}`);if(!execution) throw new Error("DRIVER_EXECUTION_LOCK_REQUIRED");
      await client.query("UPDATE execution.driver_leg_service_control SET pickup_arrived_at=$3 WHERE tenant_id=$1 AND execution_id=$2 AND pickup_arrived_at IS NULL",[tenantId,execution.executionId,occurredAt]);
    },
    async appendDriverServiceProof(input: Parameters<TenantMutationTransaction["appendDriverServiceProof"]>[0]) {
      const execution=lockedExecutions.get(`${input.shiftId}:${input.tripLegId}`);if(!execution) throw new Error("DRIVER_EXECUTION_LOCK_REQUIRED");
      let recordId: string=randomUUID();let revision=1;
      const existing=await client.query(`SELECT p.evidence_id,p.evidence_record_id,p.revision_number FROM execution.driver_service_proof p
        WHERE p.tenant_id=$1 AND p.execution_id=$2 AND p.shift_id=$3 AND p.event=$4
          AND NOT EXISTS(SELECT 1 FROM execution.driver_proof_supersession s WHERE s.tenant_id=p.tenant_id AND s.supersedes_evidence_id=p.evidence_id)`,[tenantId,execution.executionId,input.shiftId,input.event]);
      if(input.supersedesEvidenceId) {
        if(existing.rows.length!==1 || existing.rows[0].evidence_id!==input.supersedesEvidenceId) throw new PersistenceConflict("stale-version","active evidence differs");
        recordId=String(existing.rows[0].evidence_record_id);revision=Number(existing.rows[0].revision_number)+1;
      } else if(existing.rowCount) throw new PersistenceConflict("duplicate","supersession required");
      else await client.query("INSERT INTO execution.evidence_record(tenant_id,id,leg_execution_id) VALUES($1,$2,$3)",[tenantId,recordId,execution.executionId]);
      await client.query("INSERT INTO execution.evidence_revision(tenant_id,id,evidence_record_id,revision_number,supersedes_revision_id,evidence_reference) VALUES($1,$2,$3,$4,$5,$6)",
        [tenantId,input.evidenceId,recordId,revision,input.supersedesEvidenceId ?? null,`kr.private-evidence:${input.evidenceId}`]);
      await client.query(`INSERT INTO execution.driver_service_proof(tenant_id,evidence_id,shift_id,execution_id,event,policy_version,policy_digest,digest,stroke_digest,signer_role,unsigned_payload,evidence_record_id,revision_number)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13)`,[tenantId,input.evidenceId,input.shiftId,execution.executionId,input.event,input.policyVersion,input.policyDigest,input.digest,input.strokeDigest,input.role,JSON.stringify(input.unsignedPayload),recordId,revision]);
      if(input.supersedesEvidenceId) await client.query("INSERT INTO execution.driver_proof_supersession(tenant_id,evidence_id,supersedes_evidence_id) VALUES($1,$2,$3)",[tenantId,input.evidenceId,input.supersedesEvidenceId]);
    },
    async readActiveDriverServiceProof(input: Parameters<TenantMutationTransaction["readActiveDriverServiceProof"]>[0]) {
      const execution=lockedExecutions.get(`${input.shiftId}:${input.tripLegId}`);if(!execution) throw new Error("DRIVER_EXECUTION_LOCK_REQUIRED");
      const row=(await client.query(`SELECT p.evidence_id,p.digest FROM execution.driver_service_proof p
        WHERE p.tenant_id=$1 AND p.execution_id=$2 AND p.shift_id=$3 AND p.event=$4
          AND NOT EXISTS(SELECT 1 FROM execution.driver_proof_supersession s WHERE s.tenant_id=p.tenant_id AND s.supersedes_evidence_id=p.evidence_id)
        ORDER BY p.revision_number DESC LIMIT 1`,[tenantId,execution.executionId,input.shiftId,input.event])).rows[0];
      return row ? { evidenceId: String(row.evidence_id), digest: String(row.digest) } : null;
    },
    async readDriverCredentialForLogin(input: Parameters<TenantMutationTransaction["readDriverCredentialForLogin"]>[0]) {
      const row=(await client.query("SELECT driver_id,status FROM platform.driver_credential WHERE tenant_id=$1 AND login_id=$2",[tenantId,input.loginId])).rows[0];
      return row ? { driverId: String(row.driver_id), status: String(row.status) } : null;
    },
    async strokeDigestOwner(input: Parameters<TenantMutationTransaction["strokeDigestOwner"]>[0]) {
      const row=(await client.query(`SELECT evidence_id FROM execution.driver_service_proof
        WHERE tenant_id=$1 AND stroke_digest=$2 AND evidence_id<>$3 LIMIT 1`,[tenantId,input.strokeDigest,input.evidenceId])).rows[0];
      return row ? String(row.evidence_id) : null;
    },
    async appendDriverLegException(input: Parameters<TenantMutationTransaction["appendDriverLegException"]>[0]) {
      const execution=lockedExecutions.get(`${input.shiftId}:${input.tripLegId}`);if(!execution) throw new Error("DRIVER_EXECUTION_LOCK_REQUIRED");
      await client.query("INSERT INTO execution.driver_leg_exception(tenant_id,action_id,shift_id,execution_id,kind,documentation) VALUES($1,$2,$3,$4,$5,$6::jsonb)",[tenantId,input.actionId,input.shiftId,execution.executionId,input.kind,JSON.stringify(input.documentation)]);
      if(input.kind==='INCIDENT' && execution.lifecycle==='ONBOARD') await client.query("INSERT INTO execution.driver_recovery_case(tenant_id,action_id,execution_id) VALUES($1,$2,$3)",[tenantId,input.actionId,execution.executionId]);
    },
    async lockDriverActionShift(input: Parameters<TenantMutationTransaction["lockDriverActionShift"]>[0]) {
      const result = await client.query(`SELECT s.assignment_id,s.lifecycle,s.aggregate_version,s.shift_generation,s.policy_digest,s.effective_policy,s.pinned_assignment_version,
        a.run_id,a.vehicle_id,a.aggregate_version AS assignment_version,r.lifecycle_reference AS run_lifecycle,
        EXISTS(SELECT 1 FROM dispatch.assignment_supersession su WHERE su.tenant_id=a.tenant_id AND su.prior_assignment_id=a.id) AS superseded
        FROM execution.shift_policy_snapshot s JOIN dispatch.assignment a ON a.tenant_id=s.tenant_id AND a.id=s.assignment_id
        JOIN dispatch.run r ON r.tenant_id=a.tenant_id AND r.id=a.run_id
        WHERE s.tenant_id=$1 AND s.id=$2 AND s.driver_id=$3 AND a.driver_id=$3 FOR UPDATE OF s,a,r`,
        [tenantId,input.shiftId,input.driverId]);
      const row = result.rows[0]; if (!row) return null;
      // Serialize vehicle safety decisions across different shifts/runs as well.
      // Every precheck and execution action acquires this before reading defects.
      if (row.vehicle_id !== null) {
        const vehicle = await client.query(`SELECT id FROM fleet.vehicle WHERE tenant_id=$1 AND id=$2 FOR UPDATE`, [tenantId,row.vehicle_id]);
        if (!vehicle.rows[0]) return null;
      }
      lockedActionShifts.add(input.shiftId);
      const sequence = await client.query(`SELECT coalesce(max(sequence_number),0) AS sequence
        FROM execution.driver_action_receipt WHERE tenant_id=$1 AND shift_id=$2`, [tenantId,input.shiftId]);
      return { assignmentId: String(row.assignment_id), assignmentVersion: Number(row.assignment_version),
        vehicleId: row.vehicle_id === null ? null : String(row.vehicle_id), runId: String(row.run_id), runLifecycle: String(row.run_lifecycle),
        lifecycle: row.superseded || row.pinned_assignment_version === null || Number(row.pinned_assignment_version) !== Number(row.assignment_version) ? "INVALIDATE_REVIEW" : String(row.lifecycle), version: Number(row.aggregate_version), shiftGeneration: String(row.shift_generation),
        policyDigest: String(row.policy_digest), effectivePolicy: row.effective_policy as JsonValue,
        lastSequence: Number(sequence.rows[0].sequence) };
    },
    async readDriverActionReceipt(input: Parameters<TenantMutationTransaction["readDriverActionReceipt"]>[0]) {
      if (!lockedActionShifts.has(input.shiftId)) throw new Error("DRIVER_SHIFT_LOCK_REQUIRED");
      const result = await client.query(`SELECT client_action_id,idempotency_key,command_fingerprint,sequence_number,
        outcome,resource_version,reason_code FROM execution.driver_action_receipt
        WHERE tenant_id=$1 AND shift_id=$2 AND (client_action_id=$3 OR idempotency_key=$4)`,
        [tenantId,input.shiftId,input.clientActionId,input.idempotencyKey]);
      if (result.rows.length > 1) throw new PersistenceConflict("idempotency-mismatch", "action identities disagree");
      const row = result.rows[0]; if (!row) return null;
      return { clientActionId: String(row.client_action_id), idempotencyKey: String(row.idempotency_key),
        fingerprint: String(row.command_fingerprint), sequence: Number(row.sequence_number),
        outcome: row.outcome as "APPLIED" | "REJECTED", resourceVersion: row.resource_version === null ? null : Number(row.resource_version),
        reasonCode: row.reason_code === null ? null : String(row.reason_code) };
    },
    async appendDriverActionReceipt(input: Parameters<TenantMutationTransaction["appendDriverActionReceipt"]>[0]) {
      if (!lockedActionShifts.has(input.shiftId)) throw new Error("DRIVER_SHIFT_LOCK_REQUIRED");
      const prior = await client.query(`SELECT coalesce(max(sequence_number),0) AS sequence
        FROM execution.driver_action_receipt WHERE tenant_id=$1 AND shift_id=$2`, [tenantId,input.shiftId]);
      if (input.sequence !== Number(prior.rows[0].sequence) + 1) throw new PersistenceConflict("stale-version", "driver action sequence gap");
      await client.query(`INSERT INTO execution.driver_action_receipt
        (tenant_id,client_action_id,shift_id,sequence_number,idempotency_key,command_fingerprint,command_reference,
         resource_reference,outcome,resource_version,reason_code,captured_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [tenantId,input.clientActionId,input.shiftId,input.sequence,input.idempotencyKey,input.fingerprint,input.command,
          input.resourceReference,input.outcome,input.resourceVersion,input.reasonCode,input.capturedAt]);
    },
    async readDriverShiftContext(input: Parameters<TenantMutationTransaction["readDriverShiftContext"]>[0]) {
      const assignment = await client.query(`SELECT a.aggregate_version, o.commercial_tier,
        coalesce(a.workforce_relationship,d.workforce_relationship) AS relationship
        FROM dispatch.assignment a
        JOIN fleet.driver d ON d.tenant_id=a.tenant_id AND d.id=a.driver_id
        JOIN dispatch.run r ON r.tenant_id=a.tenant_id AND r.id=a.run_id
        JOIN platform.organization o ON o.tenant_id=a.tenant_id AND o.id=a.tenant_id
        WHERE a.tenant_id=$1 AND a.id=$2 AND a.driver_id=$3 AND r.service_date=$4
          AND NOT EXISTS(SELECT 1 FROM dispatch.assignment_supersession su WHERE su.tenant_id=a.tenant_id AND su.prior_assignment_id=a.id)
          AND r.lifecycle_reference NOT IN ('cancelled','completed')
        FOR UPDATE OF a,d,r,o`, [tenantId, input.assignmentId, input.driverId, input.serviceDate]);
      const row = assignment.rows[0]; if (!row) return null;
      const active = await client.query(`SELECT policy_version,controls,locks,scope_kind FROM platform.driver_control_policy
        WHERE tenant_id=$1 AND organization_id=$1 AND lifecycle='ACTIVE' FOR SHARE`, [tenantId]);
      // Branch/fleet/role precedence is not implemented here: refuse, never ignore it.
      if (active.rows.length !== 1 || active.rows[0]?.scope_kind !== 'ORGANIZATION') throw new Error("DRIVER_SCOPED_POLICY_NOT_SUPPORTED");
      const policy = active.rows[0];
      const floors = await client.query(`SELECT controls FROM platform.driver_external_floor_reference
        WHERE tenant_id=$1 AND organization_id=$1 AND effective_from<=now()
        AND (effective_until IS NULL OR effective_until>now()) FOR SHARE`, [tenantId]);
      const shifts = await client.query(`SELECT id FROM execution.shift_policy_snapshot WHERE tenant_id=$1
        AND driver_id=$2 AND lifecycle<>'SHIFT_ENDED' LIMIT 1`, [tenantId, input.driverId]);
      if (shifts.rowCount) throw new PersistenceConflict("shift-open", "driver already has an active shift");
      return { assignmentVersion: Number(row.aggregate_version), commercialTier: String(row.commercial_tier),
        relationship: String(row.relationship), policyVersion: Number(policy.policy_version), controls: policy.controls,
        locks: policy.locks, externalFloors: floors.rows.map(floor => floor.controls) };
    },
    async pinDriverShift(input: Parameters<TenantMutationTransaction["pinDriverShift"]>[0]) {
      await client.query(`INSERT INTO execution.shift_policy_snapshot
        (tenant_id,id,assignment_id,driver_id,shift_generation,policy_version,policy_digest,effective_policy,pinned_assignment_version)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)`, [tenantId, input.snapshotId, input.assignmentId,
        input.driverId, input.shiftGeneration, input.policyVersion, input.policyDigest, JSON.stringify(input.effectivePolicy),input.assignmentVersion]);
    },
    async readTrip(tripId: string) {
      const result = await client.query(`SELECT ${tripColumns}
        FROM intake.trip_request t WHERE t.tenant_id=$1 AND t.id=$2 FOR UPDATE`, [tenantId, tripId]);
      return result.rows[0] ? rowToTrip(result.rows[0]) : null;
    },
    async createTripDraft(input: Parameters<TenantMutationTransaction["createTripDraft"]>[0]) {
      const result = await client.query(`INSERT INTO intake.trip_request (
        tenant_id,id,rider_id,service_date,service_timezone,local_service_time,resolved_service_at,
        resolved_utc_offset_seconds,ambiguity_policy,ambiguity_policy_version,lifecycle_reference
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'civil-v1','draft')
      RETURNING id,rider_id,service_date,service_timezone,resolved_service_at,lifecycle_reference,aggregate_version`,
      [tenantId, input.tripId, input.riderId, input.serviceDate, input.serviceTimezone, input.localServiceTime,
        input.resolvedServiceAt, input.resolvedUtcOffsetSeconds, input.ambiguityPolicy]);
      const row = result.rows[0];
      if (!row) throw new Error("trip insert returned no row");
      return rowToTrip(row) as Awaited<ReturnType<TenantMutationTransaction["createTripDraft"]>>;
    },
    async updateTripLifecycle(input: Parameters<TenantMutationTransaction["updateTripLifecycle"]>[0]) {
      const result = await client.query(`UPDATE intake.trip_request SET lifecycle_reference=$1,
        aggregate_version=aggregate_version+1,updated_at=now()
        WHERE tenant_id=$2 AND id=$3 AND aggregate_version=$4
        RETURNING id,rider_id,service_date,service_timezone,resolved_service_at,lifecycle_reference,aggregate_version`,
      [input.lifecycleReference, tenantId, input.tripId, input.expectedVersion]);
      const row = result.rows[0];
      if (!row) throw new PersistenceConflict("stale-version", "trip version is stale");
      return rowToTrip(row) as Awaited<ReturnType<TenantMutationTransaction["updateTripLifecycle"]>>;
    },
    async replaceDriverControlPolicy(input: Parameters<TenantMutationTransaction["replaceDriverControlPolicy"]>[0]) {
      const current = await client.query<{ id: string; policy_version: string }>(`SELECT id,policy_version
        FROM platform.driver_control_policy WHERE tenant_id=$1 AND organization_id=$2 AND scope_kind='ORGANIZATION'
        AND scope_reference IS NULL AND lifecycle='ACTIVE' FOR UPDATE`, [tenantId, input.organizationId]);
      const active = current.rows[0];
      if (!active || Number(active.policy_version) !== input.expectedVersion) throw new PersistenceConflict("stale-version", "driver policy version is stale");
      const nextVersion = input.expectedVersion + 1;
      await client.query("UPDATE platform.driver_control_policy SET lifecycle='SUPERSEDED',aggregate_version=aggregate_version+1 WHERE tenant_id=$1 AND id=$2", [tenantId, active.id]);
      await client.query(`INSERT INTO platform.driver_control_policy (
        tenant_id,id,organization_id,scope_kind,scope_reference,policy_version,controls,locks,reason_code,created_by
      ) VALUES ($1,$2,$3,'ORGANIZATION',NULL,$4,$5::jsonb,$6::jsonb,$7,$8)`, [tenantId, input.policyId, input.organizationId,
        nextVersion, JSON.stringify(input.controls), JSON.stringify(input.locks), input.reasonCode, input.actorId]);
      return { policyId: input.policyId, version: nextVersion };
    },
    async appendAudit(input: Parameters<TenantMutationTransaction["appendAudit"]>[0]) {
      await client.query(`INSERT INTO audit.event (
        tenant_id,id,aggregate_kind,aggregate_id,aggregate_version,action_reference,actor_reference
      ) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [tenantId, input.auditId, input.aggregateKind, input.aggregateId,
        input.aggregateVersion, input.actionReference, input.actorReference]);
    },
    async appendOutboxMessage(input: Parameters<TenantMutationTransaction["appendOutboxMessage"]>[0]) {
      // Database time owns the mandatory minimum; preserve any longer caller retention.
      // JS millisecond precision or clock lag must not undercut recorded_at's floor.
      await client.query(`INSERT INTO outbox.message (
        tenant_id,id,event_id,aggregate_type,aggregate_id,aggregate_version,event_type,schema_version,occurred_at,
        command_id,idempotency_reference_hash,correlation_id,causation_id,source,classification_reference,
        purpose_reference,policy_reference,payload,retain_until
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18::jsonb,GREATEST($19::timestamptz,now()+interval '30 days'))`,
      [tenantId, input.messageId, input.eventId, input.aggregateType, input.aggregateId, input.aggregateVersion,
        input.eventType, input.schemaVersion, input.occurredAt, input.commandId, input.idempotencyReferenceHash,
        input.correlationId, input.causationId ?? null, input.source, input.classificationReference,
        input.purposeReference, input.policyReference, JSON.stringify(input.payload), input.retainUntil]);
    },
    async appendOutboxDelivery(input: Parameters<TenantMutationTransaction["appendOutboxDelivery"]>[0]) {
      await client.query(`INSERT INTO outbox.delivery (tenant_id,id,message_id,route,job_type,available_at,retain_until)
        VALUES ($1,$2,$3,$4,$5,$6,GREATEST($7::timestamptz,now()+interval '30 days'))`, [tenantId, input.deliveryId, input.messageId, input.route, input.jobType, input.availableAt, input.retainUntil]);
    },
  });
}

function mapDatabaseError(error: unknown): never {
  const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
  if (code === "23P01") throw new PersistenceConflict("resource-overlap", "resource reservation overlaps another run");
  if (code === "23505") throw new PersistenceConflict("duplicate", "tenant-scoped uniqueness conflict");
  if (code === "23503") throw new PersistenceConflict("relationship", "tenant-scoped relationship conflict");
  // A violated CHECK is a refused value, not an internal fault: surface it as a
  // closed relationship conflict so the caller sees a 4xx code instead of a 500.
  if (code === "23514") throw new PersistenceConflict("relationship", "a stored value violates a column constraint");
  if (code === "42501") throw new PersistenceConflict("tenant", "tenant context denied");
  throw error;
}

export async function withTenantTransaction<T>(
  pool: Pool,
  tenantId: string,
  role: RuntimeRole,
  operation: (client: PoolClient) => Promise<T>,
  isolationLevel?: "serializable",
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    if (isolationLevel === "serializable") await client.query("SET TRANSACTION ISOLATION LEVEL SERIALIZABLE");
    await client.query(`SET LOCAL ROLE ${role}`);
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    const result = await operation(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    mapDatabaseError(error);
  } finally {
    client.release();
  }
}

export function createPostgresPersistence(pool: Pool) {
  return {
    async createSyntheticOrganization(input: { tenantId: string; name: string; actor: string }) {
      return withTenantTransaction(pool, input.tenantId, "kavaroutes_api", async (client) => {
        const database = drizzle(client);
        const rows = await database.insert(organizations).values({
          tenantId: input.tenantId, id: input.tenantId, syntheticName: input.name,
        }).returning({ id: organizations.id, version: organizations.aggregateVersion });
        const created = rows[0];
        if (!created) throw new Error("organization insert returned no row");
        await database.insert(auditEvents).values({
          tenantId: input.tenantId, id: randomUUID(), aggregateKind: "organization", aggregateId: created.id,
          aggregateVersion: created.version, actionReference: "organization.created", actorReference: input.actor,
        });
        return created;
      });
    },

    async updateRunExpectedVersion(input: { tenantId: string; runId: string; expectedVersion: number; lifecycleReference: string; actor: string }) {
      return withTenantTransaction(pool, input.tenantId, "kavaroutes_api", async (client) => {
        const changed = await client.query<{ aggregate_version: string }>(`UPDATE dispatch.run
          SET lifecycle_reference = $1, aggregate_version = aggregate_version + 1, updated_at = now()
          WHERE tenant_id = $2 AND id = $3 AND aggregate_version = $4
          RETURNING aggregate_version`, [input.lifecycleReference, input.tenantId, input.runId, input.expectedVersion]);
        const row = changed.rows[0];
        if (!row) throw new PersistenceConflict("stale-version", "run version is stale");
        const nextVersion = Number(row.aggregate_version);
        await drizzle(client).insert(auditEvents).values({
          tenantId: input.tenantId, id: randomUUID(), aggregateKind: "run", aggregateId: input.runId,
          aggregateVersion: nextVersion, actionReference: "run.lifecycle-reference-changed", actorReference: input.actor,
        });
        return { version: nextVersion };
      });
    },

    async rememberIdempotentResult(input: { tenantId: string; id: string; operationKey: string; fingerprint: string; resultReference: string }) {
      return withTenantTransaction(pool, input.tenantId, "kavaroutes_api", async (client) => {
        const database = drizzle(client);
        const rows = await database.insert(idempotencyRecords).values({
          tenantId: input.tenantId, id: input.id, operationKey: input.operationKey,
          requestFingerprint: input.fingerprint, resultReference: input.resultReference, actorReference: "legacy-synthetic-actor",
          operationId: "legacy-operation", state: "COMMITTED", responseStatus: 200, responseBody: {}, responseHeaders: {},
          expiresAt: new Date(Date.now() + 86_400_000),
        }).onConflictDoNothing({ target: [idempotencyRecords.tenantId, idempotencyRecords.actorReference, idempotencyRecords.operationId, idempotencyRecords.operationKey] })
          .returning({ resultReference: idempotencyRecords.resultReference });
        if (rows[0]) return { replayed: false, resultReference: rows[0].resultReference };
        const existing = await client.query<{ request_fingerprint: string; result_reference: string }>(
          "SELECT request_fingerprint, result_reference FROM platform.idempotency_record WHERE tenant_id = $1 AND actor_reference='legacy-synthetic-actor' AND operation_id='legacy-operation' AND operation_key = $2",
          [input.tenantId, input.operationKey],
        );
        const result = existing.rows[0];
        if (!result || result.request_fingerprint !== input.fingerprint) {
          throw new PersistenceConflict("duplicate", "idempotency key was reused with a different fingerprint");
        }
        return { replayed: true, resultReference: result.result_reference };
      });
    },

    async executeIdempotentMutation<T>(input: {
      tenantId: string; actorReference: string; operationId: string; key: string; fingerprint: string;
      recordId: string; expiresAt: Date; failBeforeCommit?: boolean;
      isolationLevel?: "serializable";
    }, effect: (transaction: TenantMutationTransaction) => Promise<{ statusCode: number; body: T; headers: Readonly<Record<string, string>>; resultReference: string }>): Promise<StoredMutationResult<T>> {
      return withTenantTransaction(pool, input.tenantId, "kavaroutes_api", async (client) => {
        const inserted = await client.query(`INSERT INTO platform.idempotency_record (
          tenant_id,id,operation_key,request_fingerprint,result_reference,actor_reference,operation_id,state,
          response_status,response_body,response_headers,expires_at
        ) VALUES ($1,$2,$3,$4,'pending',$5,$6,'IN_PROGRESS',500,'{}'::jsonb,'{}'::jsonb,$7)
        ON CONFLICT (tenant_id,actor_reference,operation_id,operation_key) DO NOTHING RETURNING id`,
        [input.tenantId, input.recordId, input.key, input.fingerprint, input.actorReference, input.operationId, input.expiresAt]);

        if (inserted.rowCount === 0) {
          const existing = await client.query(`SELECT request_fingerprint,state,response_status,response_body,response_headers,expires_at
            FROM platform.idempotency_record WHERE tenant_id=$1 AND actor_reference=$2 AND operation_id=$3 AND operation_key=$4`,
          [input.tenantId, input.actorReference, input.operationId, input.key]);
          const row = existing.rows[0];
          if (!row) throw new PersistenceConflict("duplicate", "idempotency conflict");
          if (row.request_fingerprint !== input.fingerprint) throw new PersistenceConflict("idempotency-mismatch", "idempotency fingerprint differs");
          if (new Date(row.expires_at) <= new Date()) throw new PersistenceConflict("idempotency-expired", "idempotency record expired");
          if (row.state !== "COMMITTED") throw new PersistenceConflict("idempotency-in-progress", "idempotency operation unresolved");
          return { replayed: true, statusCode: row.response_status, body: row.response_body as T, headers: row.response_headers as Record<string, string> };
        }

        const committed = await effect(transactionAdapter(client, input.tenantId));
        await client.query(`UPDATE platform.idempotency_record SET state='COMMITTED',result_reference=$1,
          response_status=$2,response_body=$3::jsonb,response_headers=$4::jsonb
          WHERE tenant_id=$5 AND id=$6`, [committed.resultReference, committed.statusCode, JSON.stringify(committed.body),
          JSON.stringify(committed.headers), input.tenantId, input.recordId]);
        if (input.failBeforeCommit) throw new Error("SYNTHETIC_FAILURE_BEFORE_COMMIT");
        return { replayed: false, statusCode: committed.statusCode, body: committed.body, headers: committed.headers };
      }, input.isolationLevel);
    },

    async readTrip(tenantId: string, tripId: string) {
      return withTenantTransaction(pool, tenantId, "kavaroutes_api", async (client) => {
        const result = await client.query(`SELECT id,rider_id,service_date,service_timezone,resolved_service_at,lifecycle_reference,aggregate_version
          FROM intake.trip_request WHERE tenant_id=$1 AND id=$2`, [tenantId, tripId]);
        return result.rows[0] ? rowToTrip(result.rows[0]) : null;
      });
    },

    async listTrips(tenantId: string, input: { afterId?: string; limit: number }) {
      return withTenantTransaction(pool, tenantId, "kavaroutes_api", async (client) => {
        const result = await client.query(`SELECT ${tripColumns}
          FROM intake.trip_request t WHERE t.tenant_id=$1 AND ($2::uuid IS NULL OR t.id>$2::uuid) ORDER BY t.id LIMIT $3`,
        [tenantId, input.afterId ?? null, input.limit + 1]);
        return result.rows.map(rowToTrip);
      });
    },

    async searchSyntheticRiders(tenantId: string, prefix: string, limit: number) {
      return withTenantTransaction(pool, tenantId, "kavaroutes_api", async (client) => {
        const result = await client.query<{ id: string; synthetic_reference: string }>(`SELECT id,synthetic_reference FROM intake.rider
          WHERE tenant_id=$1 AND synthetic_reference LIKE $2 ESCAPE '\\' ORDER BY synthetic_reference,id LIMIT $3`,
        [tenantId, `${prefix.replaceAll("%", "\\%").replaceAll("_", "\\_")}%`, limit]);
        return result.rows.map((row) => ({ riderId: row.id, syntheticReference: row.synthetic_reference }));
      });
    },

    async readDispatchDay(tenantId: string, serviceDate: string) {
      return withTenantTransaction(pool, tenantId, "kavaroutes_api", async (client) => {
        const result = await client.query(`SELECT id,service_timezone,planned_start_at,planned_end_at,lifecycle_reference,aggregate_version
          FROM dispatch.run WHERE tenant_id=$1 AND service_date=$2 ORDER BY planned_start_at,id LIMIT 200`, [tenantId, serviceDate]);
        return result.rows.map((row) => ({ runId: row.id as string, serviceTimezone: row.service_timezone as string,
          plannedStartAt: (row.planned_start_at as Date).toISOString(), plannedEndAt: (row.planned_end_at as Date).toISOString(),
          lifecycle: String(row.lifecycle_reference).toUpperCase(), version: Number(row.aggregate_version) }));
      });
    },

    async advanceCurrentPosition(input: {
      tenantId: string; subjectKind: "driver" | "vehicle"; subjectId: string; deviceId: string;
      streamEpoch: number; sequenceNumber: number; capturedAt: Date; recordedAt: Date;
      longitude: number; latitude: number; sourceBatchId?: string;
    }) {
      return withTenantTransaction(pool, input.tenantId, "kavaroutes_worker", async (client) => {
        const result = await client.query<{ advanced: boolean }>(`SELECT realtime.advance_current_position(
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11
        ) AS advanced`, [input.tenantId, input.subjectKind, input.subjectId, input.deviceId, input.streamEpoch,
          input.sequenceNumber, input.capturedAt, input.recordedAt, input.longitude, input.latitude,
          input.sourceBatchId ?? null]);
        return result.rows[0]?.advanced ?? false;
      });
    },

    tables: { organizations, runs },
  };
}

export function createPushPersistence(pool: Pool) {
  return Object.freeze({
    async upsertRegistration(input: {
      tenantId: string; id: string; organizationId: string; principalId: string; subjectId: string; installationId: string;
      generation: string; platform: "ios" | "android"; provider: "apns" | "fcm"; environment: "sandbox" | "development";
      appId: string; tokenCiphertext: Uint8Array; tokenKeyedHash: Uint8Array; permission: string; channelEnabled: boolean;
    }) {
      return withTenantTransaction(pool, input.tenantId, "kavaroutes_api", async (client) => {
        await client.query(`UPDATE notification.installation_registration SET lifecycle='INACTIVE',inactive_reason='installation_replaced',invalidated_at=now(),refreshed_at=now()
          WHERE tenant_id=$1 AND installation_id=$2 AND installation_generation<>$3 AND lifecycle='ACTIVE'`, [input.tenantId, input.installationId, input.generation]);
        const result = await client.query(`INSERT INTO notification.installation_registration
          (tenant_id,id,organization_id,principal_id,subject_id,installation_id,installation_generation,platform,provider,provider_environment,app_identity,token_ciphertext,token_keyed_hash,permission_state,channel_enabled)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
          ON CONFLICT (tenant_id,installation_id,installation_generation) DO UPDATE SET
          token_ciphertext=excluded.token_ciphertext,token_keyed_hash=excluded.token_keyed_hash,permission_state=excluded.permission_state,
          channel_enabled=excluded.channel_enabled,lifecycle='ACTIVE',inactive_reason=NULL,invalidated_at=NULL,refreshed_at=now(),last_confirmed_at=now()
          WHERE notification.installation_registration.organization_id=excluded.organization_id
            AND notification.installation_registration.principal_id=excluded.principal_id
            AND notification.installation_registration.subject_id=excluded.subject_id
          RETURNING id,lifecycle,last_confirmed_at`, [input.tenantId, input.id, input.organizationId, input.principalId, input.subjectId,
          input.installationId, input.generation, input.platform, input.provider, input.environment, input.appId,
          Buffer.from(input.tokenCiphertext), Buffer.from(input.tokenKeyedHash), input.permission, input.channelEnabled]);
        if (!result.rows[0]) throw new PersistenceConflict("relationship", "registration binding differs");
        return { id: result.rows[0].id as string, lifecycle: result.rows[0].lifecycle as string, lastConfirmedAt: (result.rows[0].last_confirmed_at as Date).toISOString() };
      });
    },
    async deactivateRegistration(input: { tenantId: string; organizationId: string; principalId: string; subjectId: string; installationId: string; generation: string; reason: string }) {
      return withTenantTransaction(pool, input.tenantId, "kavaroutes_api", async (client) => {
        const result = await client.query(`UPDATE notification.installation_registration SET lifecycle='INACTIVE',inactive_reason=$1,invalidated_at=now(),refreshed_at=now()
          WHERE tenant_id=$2 AND organization_id=$3 AND principal_id=$4 AND subject_id=$5 AND installation_id=$6 AND installation_generation=$7 AND lifecycle='ACTIVE'
          RETURNING id`, [input.reason, input.tenantId, input.organizationId, input.principalId, input.subjectId, input.installationId, input.generation]);
        if (!result.rows[0]) throw new PersistenceConflict("relationship", "registration hidden or inactive");
        return { id: result.rows[0].id as string };
      });
    },
    async activeRegistrationCount(tenantId: string, principalId: string) {
      return withTenantTransaction(pool, tenantId, "kavaroutes_push_worker", async (client) => {
        const result = await client.query<{ count: number }>("SELECT count(*)::int AS count FROM notification.installation_registration WHERE tenant_id=$1 AND principal_id=$2 AND lifecycle='ACTIVE'", [tenantId, principalId]);
        return result.rows[0]?.count ?? 0;
      });
    },
  });
}
