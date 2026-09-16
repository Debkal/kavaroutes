import { createHash, randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { Type, type Static } from "typebox";
import { createPostgresPersistence, createDriverShiftReader, PersistenceConflict, type JsonValue, type StoredMutationResult } from "@kavaroutes/postgres-persistence";
import type { SyntheticPrincipal } from "./security.js";
import { validateInspectionJpeg } from "./inspection-jpeg.js";
import { ProtocolError, requestFingerprint } from "./protocol.js";
import { EffectiveDriverPolicySchema } from "./schemas.js";

// Versioned baseline matches the existing Driver form; no jurisdiction-completeness claim.
export const precheckItems = [
  "Service and parking brakes", "Steering and suspension", "Horn", "Mirrors, cameras, and backup alarm",
  "Glass, wipers, washer, and defrost", "Lights, reflectors, signals, and hazards", "Tires, wheels, rims, lugs, and spare kit",
  "Engine, warnings, battery, fuel or charge, fluids, leaks, and exhaust", "Doors, locks, exits, steps, handrails, seats, headrests, and belts",
  "Heating, cooling, and ventilation", "Emergency, first-aid, spill, flashlight, and communication equipment",
  "Cleanliness, contamination, pests, odor, loose objects, body damage, and lost property",
  "Wheelchair lift, ramp, interlocks, manual backup, securement, tiedowns, and occupant restraints",
  "Stretcher mounts, oxygen storage, and configured specialty equipment", "Device mount, charger, navigation, and location",
  "Required vehicle documents", "Organization extension: sanitizing supplies", "Other unsafe condition",
  "Vehicle extension: configured specialty restraint", "Funding-source extension: required safety kit",
] as const;
const closed = { additionalProperties: false } as const;
const id = () => Type.String({ format: "uuid" });
const digest = () => Type.String({ pattern: "^[a-f0-9]{64}$", minLength: 64, maxLength: 64 });
const fuel = () => Type.Union(["EMPTY", "QUARTER", "HALF", "THREE_QUARTERS", "FULL"].map(value => Type.Literal(value)));
const skip = Type.Object({ decision: Type.Literal("SKIPPED"), reason: Type.Literal("OPTIONAL_CONTROL_SKIPPED") }, closed);
const entry = Type.Object({
  item: Type.Union(precheckItems.map(value => Type.Literal(value))),
  response: Type.Union([Type.Literal("NO_DEFECT"), Type.Literal("DEFECT_FOUND"), Type.Literal("NOT_APPLICABLE")]),
  severity: Type.Optional(Type.Union([Type.Literal("CRITICAL_OUT_OF_SERVICE"), Type.Literal("SERVICE_AFFECTING"), Type.Literal("MINOR")])),
  note: Type.Optional(Type.String({ minLength: 1, maxLength: 2000 })), photoDigest: Type.Optional(digest()),
  photoException: Type.Optional(Type.Union([Type.Literal("UNSAFE_TO_CAPTURE"), Type.Literal("CAMERA_UNAVAILABLE")])),
}, closed);
export const DriverPrecheckRequestSchema = Type.Object({
  shiftGeneration: id(), vehicleId: id(), policyDigest: digest(), expectedVersion: Type.Integer({ minimum: 1 }),
  capturedAt: Type.String({ format: "date-time" }),
  inspection: Type.Optional(Type.Union([skip, Type.Object({ decision: Type.Literal("COMPLETED"),
    definitionVersion: Type.Literal("inspection-synthetic-v2"), entries: Type.Array(entry, { minItems: 20, maxItems: 20 }) }, closed)])),
  odometer: Type.Optional(Type.Union([skip, Type.Object({ decision: Type.Literal("COMPLETED"),
    value: Type.Integer({ minimum: 0, maximum: 9999999 }), fuelLevel: fuel() }, closed)])),
  photos: Type.Array(Type.Object({ digest: digest(), base64: Type.String({ minLength: 136, maxLength: 200000,
    pattern: "^[A-Za-z0-9+/]+={0,2}$" }) }, closed), { maxItems: 20 }),
}, { ...closed, $id: "DriverPrecheckRequest", title: "DriverPrecheckRequest" });
const controlOutcome = () => Type.Union([Type.Literal("COMPLETED"), Type.Literal("SKIPPED"), Type.Literal("NOT_REQUIRED")]);
export const DriverPrecheckReceiptSchema = Type.Object({
  shiftReference: id(), vehicleId: id(), resourceVersion: Type.Integer({ minimum: 2 }),
  vehicleState: Type.Union([Type.Literal("READY"), Type.Literal("BLOCKED_CRITICAL_DEFECT")]),
  inspectionOutcome: controlOutcome(), odometerOutcome: controlOutcome(),
  odometer: Type.Union([Type.Integer({ minimum: 0, maximum: 9999999 }), Type.Null()]),
  fuelLevel: Type.Union([fuel(), Type.Null()]),
}, { ...closed, $id: "DriverPrecheckReceipt", title: "DriverPrecheckReceipt" });
export type DriverPrecheckRequest = Static<typeof DriverPrecheckRequestSchema>;
export type DriverPrecheckReceipt = Static<typeof DriverPrecheckReceiptSchema>;
export const DriverShiftStateSchema = Type.Object({
  shiftReference: id(), shiftGeneration: id(), resourceVersion: Type.Integer({ minimum: 1 }),
  lastActionSequence: Type.Integer({ minimum: 0 }),
  lifecycle: Type.Union([Type.Literal("ACTIVE"), Type.Literal("INVALIDATE_REVIEW"), Type.Literal("SHIFT_ENDED")]),
  effectivePolicy: Type.Unsafe<Static<typeof EffectiveDriverPolicySchema>>({ $ref: "EffectiveDriverPolicy" }),
  precheck: Type.Union([Type.Null(), DriverPrecheckReceiptSchema]),
}, { ...closed, $id: "DriverShiftState", title: "DriverShiftState" });
export type DriverShiftState = Static<typeof DriverShiftStateSchema>;
export interface DriverShiftReader { (organizationId: string, driverId: string, assignmentId: string): Promise<DriverShiftState | null> }
export function createPostgresDriverShiftStateReader(pool: Pool): DriverShiftReader {
  const read = createDriverShiftReader(pool);
  return async (...input) => await read(...input) as unknown as DriverShiftState | null;
}
type SubmitInput = { organizationId: string; shiftId: string; principal: SyntheticPrincipal; key: string; request: DriverPrecheckRequest };
export interface DriverPrecheckService {
  submit(input: SubmitInput): Promise<StoredMutationResult<DriverPrecheckReceipt>>;
}
const invalid = (code: string): never => { throw new ProtocolError(422, code, "precheck decision invalid"); };
function resolveOutcome(mode: unknown, input: { decision: string } | undefined) {
  if (!["DISABLED", "OPTIONAL", "REQUIRED"].includes(String(mode))) throw new Error("DRIVER_POLICY_STORAGE_INVALID");
  if (mode === "DISABLED") { if (input) invalid("DISABLED_CONTROL_MUST_BE_OMITTED"); return "NOT_REQUIRED" as const; }
  if (!input) invalid("CONTROL_DECISION_REQUIRED");
  if (input!.decision === "SKIPPED" && mode !== "OPTIONAL") invalid("REQUIRED_CONTROL_CANNOT_BE_SKIPPED");
  return input!.decision as "COMPLETED" | "SKIPPED";
}
export function createPostgresDriverPrecheckService(pool: Pool, options: { now?: () => Date;stage?:'PRE'|'POST' } = {}): DriverPrecheckService {
  const persistence = createPostgresPersistence(pool); const now = options.now ?? (() => new Date());
  const stage=options.stage??'PRE';
  return Object.freeze({
    async submit(input: SubmitInput) {
      const { request } = input; const driverId = input.principal.subjectId;
      if (!driverId || input.principal.organizationId !== input.organizationId || !input.principal.capabilities.has("driver:execute") ||
        !input.principal.purposes.has("ASSIGNED_SERVICE_DELIVERY")) throw new ProtocolError(404, "RESOURCE_NOT_FOUND", "resource hidden");
      const fingerprint = requestFingerprint({ shiftId: input.shiftId, request });
      return persistence.executeIdempotentMutation({ tenantId: input.organizationId, actorReference: input.principal.id,
        operationId: stage==='POST'?'submitDriverPostcheck':"submitDriverPrecheck", key: input.key, fingerprint, recordId: randomUUID(),
        expiresAt: new Date(now().getTime() + 86_700_000), isolationLevel: "serializable" }, async tx => {
        const shift = await tx.lockDriverActionShift({ shiftId: input.shiftId, driverId });
        if (!shift || shift.shiftGeneration !== request.shiftGeneration) throw new ProtocolError(404, "RESOURCE_NOT_FOUND", "resource hidden");
        if (shift.lifecycle !== "ACTIVE" || ["cancelled", "aborted", "completed"].includes(shift.runLifecycle.toLowerCase())) {
          throw new ProtocolError(409, "DRIVER_SHIFT_NOT_ACTIVE", "shift unavailable");
        }
        if (shift.vehicleId !== request.vehicleId) invalid("ASSIGNED_VEHICLE_MISMATCH");
        if (shift.policyDigest !== request.policyDigest) invalid("PINNED_POLICY_MISMATCH");
        if (shift.version !== request.expectedVersion) throw new PersistenceConflict("stale-version", "shift version is stale");
        if (await tx.readDriverPrecheck(input.shiftId,stage)) throw new ProtocolError(409, "VEHICLE_CHECK_ALREADY_RECORDED", "decision immutable");
        if(stage==='POST'&&await tx.hasUnfinishedDriverLegs(input.shiftId))throw new ProtocolError(409,'UNFINISHED_SHIFT_WORK','complete or resolve assigned work first');
        if (stage==='PRE'&&await tx.hasUnresolvedCriticalVehicleDefect(input.shiftId, request.vehicleId)) throw new ProtocolError(409, "CRITICAL_DEFECT_BLOCKS_RELEASE", "vehicle clearance required");
        const policy = shift.effectivePolicy as unknown as { preInspection: { mode: string }; startOdometer: { mode: string };postInspection:{mode:string};endOdometer:{mode:string} };
        const inspectionOutcome = resolveOutcome(stage==='POST'?policy.postInspection.mode:policy.preInspection.mode, request.inspection);
        const odometerOutcome = resolveOutcome(stage==='POST'?policy.endOdometer.mode:policy.startOdometer.mode, request.odometer);
        if(stage==='POST'&&request.odometer?.decision==='COMPLETED'){
          const start=await tx.readDriverPrecheck(input.shiftId);
          if(start?.odometer!==null&&start?.odometer!==undefined&&request.odometer.value<start.odometer)invalid('ENDING_ODOMETER_BELOW_START');
          if(policy.startOdometer.mode==='REQUIRED'&&start?.odometer==null)invalid('ACCEPTED_START_ODOMETER_REQUIRED');
        }
        const entries = request.inspection?.decision === "COMPLETED" ? request.inspection.entries : [];
        if (entries.length && (new Set(entries.map(item => item.item)).size !== 20 ||
          precheckItems.some(item => !entries.some(entry => entry.item === item)))) invalid("INSPECTION_ITEMS_INCOMPLETE");
        const expectedPhotos = new Set<string>(); let critical = false;
        for (const entry of entries) {
          if (entry.response !== "DEFECT_FOUND") {
            if (entry.severity || entry.note || entry.photoDigest || entry.photoException) invalid("DEFECT_FIELDS_WITHOUT_DEFECT");
            continue;
          }
          if (!entry.severity || !entry.note?.trim() || Boolean(entry.photoDigest) === Boolean(entry.photoException)) invalid("DEFECT_DETAILS_REQUIRED");
          critical ||= entry.severity === "CRITICAL_OUT_OF_SERVICE";
          if (entry.photoDigest) {
            if (expectedPhotos.has(entry.photoDigest)) invalid("DEFECT_PHOTO_REUSED");
            expectedPhotos.add(entry.photoDigest);
          }
        }
        if (request.photos.length !== expectedPhotos.size || new Set(request.photos.map(photo => photo.digest)).size !== expectedPhotos.size) invalid("DEFECT_PHOTO_SET_MISMATCH");
        const photos = request.photos.map(photo => {
          if (!expectedPhotos.has(photo.digest)) invalid("DEFECT_PHOTO_SET_MISMATCH");
          const content = Buffer.from(photo.base64, "base64");
          if (content.toString("base64") !== photo.base64 || content.length < 100 || content.length > 150000 ||
            content[0] !== 0xff || content[1] !== 0xd8 || content[2] !== 0xff ||
            content.at(-2) !== 0xff || content.at(-1) !== 0xd9) invalid("DEFECT_PHOTO_FORMAT_INVALID");
          if (createHash("sha256").update(`DEFECT_PHOTO:${photo.base64}`).digest("hex") !== photo.digest) invalid("DEFECT_PHOTO_DIGEST_MISMATCH");
          return { digest: photo.digest, content };
        });
        for (const photo of photos) await validateInspectionJpeg(photo.content);
        const version = await tx.advanceDriverShiftVersion(input.shiftId, shift.version);
        const odometer = request.odometer?.decision === "COMPLETED" ? request.odometer.value : null;
        const fuelLevel = request.odometer?.decision === "COMPLETED" ? request.odometer.fuelLevel : null;
        const vehicleState = critical ? "BLOCKED_CRITICAL_DEFECT" as const : "READY" as const;
        await tx.appendDriverPrecheck({ shiftId: input.shiftId, vehicleId: request.vehicleId, policyDigest: shift.policyDigest, version,
          inspectionOutcome, odometerOutcome, vehicleState, odometer, fuelLevel, answers: entries as unknown as JsonValue,
          capturedAt: new Date(request.capturedAt), photos,stage });
        await tx.appendAudit({ auditId: randomUUID(), aggregateKind: "driver-shift", aggregateId: input.shiftId, aggregateVersion: version,
          actionReference: critical ? "driver.vehicle.critical_defect_alerted" : inspectionOutcome === "SKIPPED" || odometerOutcome === "SKIPPED"
            ? "driver.control.skipped" : stage==='POST'?"driver.vehicle.postcheck.accepted":"driver.vehicle.precheck.accepted", actorReference: input.principal.id });
        const occurredAt = now(); const messageId = randomUUID(); const retainUntil = new Date(occurredAt.getTime() + 2_592_000_000);
        await tx.appendOutboxMessage({ messageId, eventId: randomUUID(), aggregateType: "DRIVER_SHIFT", aggregateId: input.shiftId,
          aggregateVersion: version, eventType: stage==='POST'?"DriverPostcheckRecorded":"DriverPrecheckRecorded", schemaVersion: "v1", occurredAt, commandId: randomUUID(),
          idempotencyReferenceHash: fingerprint, correlationId: randomUUID(), source: "kavaroutes.api", classificationReference: "OPERATIONAL_SENSITIVE",
          purposeReference: "ASSIGNED_SERVICE_DELIVERY", policyReference: "privacy-synthetic-v1",
          payload: { shiftReference: input.shiftId, driverId, assignmentId: shift.assignmentId, policyDigest: shift.policyDigest }, retainUntil });
        await tx.appendOutboxDelivery({ deliveryId: randomUUID(), messageId, route: "realtime-signal", jobType: "kr.realtime-signal.driver-shift.v1",
          availableAt: occurredAt, retainUntil });
        const body: DriverPrecheckReceipt = { shiftReference: input.shiftId, vehicleId: request.vehicleId, resourceVersion: version,
          vehicleState, inspectionOutcome, odometerOutcome, odometer, fuelLevel };
        return { statusCode: 200, body, headers: {}, resultReference: input.shiftId };
      });
    },
  });
}
