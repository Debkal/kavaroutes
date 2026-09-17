import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { Type, type Static, type TSchema } from "typebox";
import { resolveEffectiveDriverPolicy, type DriverControlSet, type InspectionControlMode, type ReturnVerificationMode, type RouteChangeMode, type ScopedControl } from "@kavaroutes/platform-engine/domain";
import { createPostgresPersistence, PersistenceConflict, type JsonValue, type StoredMutationResult } from "@kavaroutes/postgres-persistence";
import { requestFingerprint } from "./protocol.js";
import { ProtocolError } from "./protocol.js";
import type { SyntheticPrincipal } from "./security.js";
import { EffectiveDriverPolicySchema, OpaqueIdSchema, ServiceDateSchema } from "./schemas.js";

const TypeRef = <T extends TSchema>(schema: T) => Type.Unsafe<Static<T>>({ $ref: String((schema as { $id?: unknown }).$id) });
export const StartDriverShiftRequestSchema = Type.Object({
  assignmentId: TypeRef(OpaqueIdSchema), serviceDate: TypeRef(ServiceDateSchema),
  expectedAssignmentVersion: Type.Integer({ minimum: 1 }),
  /** The driver's claimed login id. When present the server refuses a start whose
   * credential is not ACTIVE for this driver, so the login gates the shift
   * (audit WEB-A-026). Optional until the native client sends it. */
  loginId: Type.Optional(Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$" })),
}, { additionalProperties: false, $id: "StartDriverShiftRequest", title: "StartDriverShiftRequest" });
export const StartDriverShiftReceiptSchema = Type.Object({
  outcome: Type.Union([Type.Literal("APPLIED"), Type.Literal("REPLAYED")]),
  shiftReference: TypeRef(OpaqueIdSchema), shiftGeneration: TypeRef(OpaqueIdSchema),
  resourceVersion: Type.Integer({ minimum: 1 }), effectivePolicy: TypeRef(EffectiveDriverPolicySchema),
}, { additionalProperties: false, $id: "StartDriverShiftReceipt", title: "StartDriverShiftReceipt" });
export type StartDriverShiftRequest = Static<typeof StartDriverShiftRequestSchema>;
export type StartDriverShiftReceipt = Static<typeof StartDriverShiftReceiptSchema>;

const inspection = new Set<InspectionControlMode>(["DISABLED", "OPTIONAL", "REQUIRED"]);
const returns = new Set<ReturnVerificationMode>(["DISABLED", "ADVISORY", "REQUIRED_WITH_AUDITED_OVERRIDE"]);
const routes = new Set<RouteChangeMode>(["AUTHORIZED_SELF_APPROVE", "DISPATCH_APPROVAL_REQUIRED", "DISABLED"]);
const keys = ["preInspection", "postInspection", "startOdometer", "endOdometer", "returnVerification", "routeChange"] as const;
type ControlKey = typeof keys[number];
const ranks: Record<ControlKey, Readonly<Record<string, number>>> = {
  preInspection: { DISABLED: 0, OPTIONAL: 1, REQUIRED: 2 }, postInspection: { DISABLED: 0, OPTIONAL: 1, REQUIRED: 2 },
  startOdometer: { DISABLED: 0, OPTIONAL: 1, REQUIRED: 2 }, endOdometer: { DISABLED: 0, OPTIONAL: 1, REQUIRED: 2 },
  returnVerification: { DISABLED: 0, ADVISORY: 1, REQUIRED_WITH_AUDITED_OVERRIDE: 2 },
  routeChange: { AUTHORIZED_SELF_APPROVE: 0, DISPATCH_APPROVAL_REQUIRED: 1, DISABLED: 2 },
};
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("DRIVER_POLICY_STORAGE_INVALID");
  const result = value as Record<string, unknown>;
  if (Object.keys(result).some(key => !(keys as readonly string[]).includes(key))) throw new Error("DRIVER_POLICY_STORAGE_INVALID");
  return result;
}
function validMode(key: ControlKey, mode: unknown): mode is string {
  if (key === "returnVerification") return returns.has(mode as ReturnVerificationMode);
  if (key === "routeChange") return routes.has(mode as RouteChangeMode);
  return inspection.has(mode as InspectionControlMode);
}
function controls(value: unknown, locksValue: unknown, forceLocked = false): DriverControlSet {
  const source = record(value); const locks = record(locksValue);
  const output: Record<string, ScopedControl<string>> = {};
  for (const key of keys) {
    const mode = source[key]; if (mode === undefined) continue;
    if (!validMode(key, mode) || (locks[key] !== undefined && typeof locks[key] !== "boolean")) throw new Error("DRIVER_POLICY_STORAGE_INVALID");
    output[key] = { mode, locked: forceLocked || locks[key] === true };
  }
  return output as DriverControlSet;
}
function mergeFloors(values: readonly unknown[]): DriverControlSet | undefined {
  const merged: Record<string, ScopedControl<string>> = {};
  for (const value of values) {
    const floor = controls(value, {}, true) as Record<ControlKey, ScopedControl<string> | undefined>;
    for (const key of keys) {
      const item = floor[key]; const prior = merged[key];
      if (item && (!prior || ranks[key][item.mode]! > ranks[key][prior.mode]!)) merged[key] = item;
    }
  }
  return values.length ? merged as DriverControlSet : undefined;
}

export interface DriverShiftService {
  start(input: { organizationId: string; principal: SyntheticPrincipal; key: string; request: StartDriverShiftRequest }): Promise<StoredMutationResult<StartDriverShiftReceipt>>;
}
export function createPostgresDriverShiftService(pool: Pool, options: { now?: () => Date; idFactory?: () => string } = {}): DriverShiftService {
  const persistence = createPostgresPersistence(pool); const now = options.now ?? (() => new Date()); const idFactory = options.idFactory ?? randomUUID;
  return Object.freeze({
    async start(input: { organizationId: string; principal: SyntheticPrincipal; key: string; request: StartDriverShiftRequest }) {
      const fingerprint = requestFingerprint(input.request);
      const result = await persistence.executeIdempotentMutation({ tenantId: input.organizationId, actorReference: input.principal.id,
        operationId: "startDriverShift", key: input.key, fingerprint, recordId: idFactory(),
        expiresAt: new Date(now().getTime() + 86_700_000), isolationLevel: "serializable" }, async transaction => {
        if (!input.principal.subjectId) throw new Error("DRIVER_SUBJECT_REQUIRED");
        if (input.request.loginId) {
          const credential = await transaction.readDriverCredentialForLogin({ loginId: input.request.loginId });
          if (!credential) throw new ProtocolError(403, "DRIVER_LOGIN_REQUIRED", "verify a driver login before starting work");
          if (credential.driverId !== input.principal.subjectId) throw new ProtocolError(403, "DRIVER_LOGIN_MISMATCH", "this login belongs to another driver");
          if (credential.status !== "ACTIVE") throw new ProtocolError(403, "DRIVER_LOGIN_REQUIRED", "this driver login has not been claimed");
        }
        const context = await transaction.readDriverShiftContext({ assignmentId: input.request.assignmentId,
          driverId: input.principal.subjectId, serviceDate: input.request.serviceDate });
        if (!context) throw new ProtocolError(404, "RESOURCE_NOT_FOUND", "resource hidden");
        if (context.assignmentVersion !== input.request.expectedAssignmentVersion) {
          throw new PersistenceConflict("stale-version", "assignment version is stale");
        }
        const resolvedAt = now();
        const externalFloor = mergeFloors(context.externalFloors);
        const effectivePolicy = resolveEffectiveDriverPolicy({ organizationId: input.organizationId,
          driverId: input.principal.subjectId, assignmentId: input.request.assignmentId,
          commercialTier: context.commercialTier as "SMALL_BUSINESS" | "ENTERPRISE",
          workforceRelationship: context.relationship as "OWNER_OPERATOR" | "EMPLOYEE" | "CONTRACTOR",
          policyVersion: context.policyVersion, resolvedAt: resolvedAt.toISOString(),
          organization: controls(context.controls, context.locks), ...(externalFloor ? { externalFloor } : {}),
          capabilities: new Set(input.principal.capabilities.has("driver-route:self-approve") ? ["driver-route:self-approve"] : []),
        });
        const shiftReference = idFactory(); const shiftGeneration = idFactory();
        await transaction.pinDriverShift({ snapshotId: shiftReference, assignmentId: input.request.assignmentId,
          assignmentVersion: context.assignmentVersion,
          driverId: input.principal.subjectId, shiftGeneration, policyVersion: effectivePolicy.policyVersion,
          policyDigest: effectivePolicy.canonicalDigest, effectivePolicy: effectivePolicy as unknown as JsonValue });
        await transaction.appendAudit({ auditId: idFactory(), aggregateKind: "driver-shift", aggregateId: shiftReference,
          aggregateVersion: 1, actionReference: "driver.shift.started", actorReference: input.principal.id });
        const messageId = idFactory();
        await transaction.appendOutboxMessage({ messageId, eventId: idFactory(), aggregateType: "DRIVER_SHIFT", aggregateId: shiftReference,
          aggregateVersion: 1, eventType: "DriverShiftStarted", schemaVersion: "v1", occurredAt: resolvedAt, commandId: idFactory(),
          idempotencyReferenceHash: fingerprint, correlationId: idFactory(), source: "kavaroutes.api",
          classificationReference: "OPERATIONAL_SENSITIVE", purposeReference: "ASSIGNED_SERVICE_DELIVERY",
          policyReference: "privacy-synthetic-v1", payload: { shiftReference, driverId: input.principal.subjectId,
            assignmentId: input.request.assignmentId, policyDigest: effectivePolicy.canonicalDigest },
          retainUntil: new Date(resolvedAt.getTime() + 2_592_000_000) });
        await transaction.appendOutboxDelivery({ deliveryId: idFactory(), messageId, route: "realtime-signal",
          jobType: "kr.realtime-signal.driver-shift.v1", availableAt: resolvedAt,
          retainUntil: new Date(resolvedAt.getTime() + 2_592_000_000) });
        const body: StartDriverShiftReceipt = { outcome: "APPLIED", shiftReference, shiftGeneration,
          resourceVersion: 1,
          effectivePolicy: effectivePolicy as unknown as StartDriverShiftReceipt["effectivePolicy"] };
        return { statusCode: 200, body, headers: {}, resultReference: shiftReference };
      });
      return result.replayed ? { ...result, body: { ...result.body, outcome: "REPLAYED" as const } } : result;
    },
  });
}
