import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { Type,type Static } from "typebox";
import { createPostgresPersistence,type StoredMutationResult } from "@kavaroutes/postgres-persistence";
import { ProtocolError,requestFingerprint } from "./protocol.js";
import type { SyntheticPrincipal } from "./security.js";

/**
 * Live device location for the driver map. The driver's browser reports real fixes while
 * the shift is open; the server keeps the trace (breadcrumbs), the current position and
 * the freshness the tracking alerts already assess. Position data never enters a log or
 * a problem body — only the closed outcomes below.
 */
const id = () => Type.String({ format: "uuid" });
const closed = { additionalProperties: false } as const;
const nullable = <T extends Parameters<typeof Type.Union>[0][number]>(schema: T) => Type.Union([schema, Type.Null()]);

export const DriverLocationSampleSchema = Type.Object({
  sampleId: id(),
  sequence: Type.Integer({ minimum: 1 }),
  capturedAt: Type.String({ format: "date-time", maxLength: 35 }),
  latitude: Type.Number({ minimum: -90, maximum: 90 }),
  longitude: Type.Number({ minimum: -180, maximum: 180 }),
  accuracyMeters: Type.Optional(nullable(Type.Number({ minimum: 0, maximum: 100000 }))),
}, { ...closed, $id: "DriverLocationSample" });
export const DriverLocationBatchRequestSchema = Type.Object({
  shiftGeneration: id(),
  batchReference: id(),
  deviceId: id(),
  /** A batch is what the app had buffered; the server keeps order by sequence. */
  samples: Type.Array(DriverLocationSampleSchema, { minItems: 1, maxItems: 120 }),
}, { ...closed, $id: "DriverLocationBatchRequest" });
export const DriverLocationReceiptSchema = Type.Object({
  shiftReference: id(),
  batchReference: id(),
  items: Type.Array(Type.Object({
    sampleId: id(),
    outcome: Type.String({ enum: ["APPLIED", "REPLAYED", "REJECTED"] }),
    code: Type.String({ enum: ["LOCATION_SAMPLE_SAVED", "SAMPLE_OUTSIDE_RETENTION"] }),
  }, closed), { minItems: 1, maxItems: 120 }),
}, { ...closed, $id: "DriverLocationReceipt" });
export type DriverLocationBatchRequest = Static<typeof DriverLocationBatchRequestSchema>;
export type DriverLocationReceipt = Static<typeof DriverLocationReceiptSchema>;

export interface DriverLocationService {
  submit(input: { organizationId: string; principal: SyntheticPrincipal; shiftId: string; key: string;
    request: DriverLocationBatchRequest }): Promise<StoredMutationResult<DriverLocationReceipt>>;
}
export function createPostgresDriverLocationService(pool: Pool): DriverLocationService {
  const persistence = createPostgresPersistence(pool);
  return {
    async submit(input) {
      const { principal, organizationId } = input;
      if (principal.organizationId !== organizationId || !principal.subjectId ||
          !principal.capabilities.has("driver:location:write") || !principal.purposes.has("ASSIGNED_SERVICE_DELIVERY"))
        throw new ProtocolError(404, "RESOURCE_NOT_FOUND", "resource hidden");
      return persistence.executeIdempotentMutation({ tenantId: organizationId, actorReference: principal.id,
        operationId: "submitDriverLocationBatch", key: input.key,
        fingerprint: requestFingerprint({ shift: input.shiftId, batch: input.request.batchReference, samples: input.request.samples }),
        recordId: randomUUID(), expiresAt: new Date(Date.now() + 86_700_000), isolationLevel: "serializable" }, async tx => {
        const shift = await tx.lockDriverActionShift({ shiftId: input.shiftId, driverId: principal.subjectId! });
        if (!shift || shift.shiftGeneration !== input.request.shiftGeneration || shift.lifecycle !== "ACTIVE")
          throw new ProtocolError(404, "RESOURCE_NOT_FOUND", "shift hidden");
        const items = await tx.recordDeviceLocations({ shiftId: input.shiftId, generation: input.request.shiftGeneration,
          deviceId: input.request.deviceId, batchReference: input.request.batchReference, samples: input.request.samples });
        return { statusCode: 200, body: { shiftReference: input.shiftId, batchReference: input.request.batchReference, items: items.map(item => ({ ...item })) },
          headers: {}, resultReference: input.shiftId };
      });
    },
  };
}
