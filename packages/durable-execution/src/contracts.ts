export const OUTBOX_ROUTES = [
  "projection", "realtime-signal", "integration", "notification",
  "maps", "optimization", "billing", "maintenance",
] as const;

export type OutboxRoute = typeof OUTBOX_ROUTES[number];

export const JOB_TYPES: Readonly<Record<OutboxRoute, readonly string[]>> = Object.freeze({
  projection: ["kr.projection.trip.v1"],
  "realtime-signal": ["kr.realtime-signal.trip.v1"],
  integration: ["kr.integration.partner.v1"],
  notification: ["kr.notification.dispatch.v1"],
  maps: ["kr.maps.route.v1"],
  optimization: ["kr.optimization.run.v1"],
  billing: ["kr.billing.claim.v1"],
  maintenance: ["kr.maintenance.retention.v1"],
});

export interface EventEnvelope<TPayload extends Record<string, unknown> = Record<string, unknown>> {
  readonly eventId: string;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly aggregateVersion: number;
  readonly eventType: string;
  readonly schemaVersion: string;
  readonly occurredAt: string;
  readonly commandId: string;
  readonly idempotencyReferenceHash: string;
  readonly correlationId: string;
  readonly causationId?: string;
  readonly source: string;
  readonly classificationReference: string;
  readonly purposeReference: string;
  readonly policyReference: string;
  readonly payload: TPayload;
}

export interface ThinJobPayload {
  readonly tenantId: string;
  readonly deliveryId: string;
  readonly eventId: string;
  readonly route: OutboxRoute;
  readonly jobType: string;
  readonly eventType: string;
  readonly schemaVersion: string;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly aggregateVersion: number;
  readonly correlationId: string;
  readonly causationId?: string;
  readonly classificationReference: string;
  readonly purposeReference: string;
  readonly policyReference: string;
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const sha256 = /^[0-9a-f]{64}$/;
const forbiddenPayloadKey = /(^|_)(name|phone|email|address|latitude|longitude|lat|lng|dob|birth|diagnosis|member|medicaid|medicare)(_|$)/i;

function assertRecord(value: unknown): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("UNSUPPORTED_SCHEMA");
}

function assertExactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): void {
  const allowed = new Set([...required, ...optional]);
  if (required.some((key) => !(key in value)) || Object.keys(value).some((key) => !allowed.has(key))) throw new Error("UNSUPPORTED_SCHEMA");
}

function assertSafePayload(value: unknown): void {
  if (Array.isArray(value)) {
    value.forEach(assertSafePayload);
    return;
  }
  if (typeof value !== "object" || value === null) return;
  for (const [key, nested] of Object.entries(value)) {
    if (forbiddenPayloadKey.test(key)) throw new Error("PAYLOAD_POLICY_VIOLATION");
    assertSafePayload(nested);
  }
}

const payloadValidators = Object.freeze({
  "TripCreated:v1": (payload: Record<string, unknown>) => {
    assertExactKeys(payload, ["tripId", "lifecycle", "version"]);
    if (!uuid.test(String(payload.tripId)) || payload.lifecycle !== "DRAFT" || !Number.isInteger(payload.version) || Number(payload.version) < 1) throw new Error("UNSUPPORTED_SCHEMA");
  },
  "TripCancelled:v1": (payload: Record<string, unknown>) => {
    assertExactKeys(payload, ["tripId", "lifecycle", "version"]);
    if (!uuid.test(String(payload.tripId)) || payload.lifecycle !== "CANCELLED" || !Number.isInteger(payload.version) || Number(payload.version) < 1) throw new Error("UNSUPPORTED_SCHEMA");
  },
  "LocationBatchRecorded:v1": (payload: Record<string, unknown>) => {
    assertExactKeys(payload, ["batchReference", "sampleCount"]);
    if (!/^ref_[a-z0-9_-]{8,96}$/.test(String(payload.batchReference)) || !Number.isInteger(payload.sampleCount) || Number(payload.sampleCount) < 1) throw new Error("UNSUPPORTED_SCHEMA");
  },
} satisfies Record<string, (payload: Record<string, unknown>) => void>);

export function validateEventEnvelope(value: unknown): EventEnvelope {
  assertRecord(value);
  const required = ["eventId", "aggregateType", "aggregateId", "aggregateVersion", "eventType", "schemaVersion", "occurredAt", "commandId", "idempotencyReferenceHash", "correlationId", "source", "classificationReference", "purposeReference", "policyReference", "payload"];
  assertExactKeys(value, required, ["causationId"]);
  if (!uuid.test(String(value.eventId)) || !uuid.test(String(value.aggregateId)) || !uuid.test(String(value.commandId)) || !uuid.test(String(value.correlationId))) throw new Error("UNSUPPORTED_SCHEMA");
  if (value.causationId !== undefined && !uuid.test(String(value.causationId))) throw new Error("UNSUPPORTED_SCHEMA");
  if (!Number.isInteger(value.aggregateVersion) || Number(value.aggregateVersion) < 1 || !sha256.test(String(value.idempotencyReferenceHash))) throw new Error("UNSUPPORTED_SCHEMA");
  if (!/^v[1-9][0-9]*$/.test(String(value.schemaVersion)) || !Number.isFinite(Date.parse(String(value.occurredAt)))) throw new Error("UNSUPPORTED_SCHEMA");
  assertRecord(value.payload);
  assertSafePayload(value.payload);
  const validator = payloadValidators[`${String(value.eventType)}:${String(value.schemaVersion)}` as keyof typeof payloadValidators];
  if (!validator) throw new Error("UNSUPPORTED_SCHEMA");
  validator(value.payload);
  return value as unknown as EventEnvelope;
}

export function validateThinJobPayload(value: unknown): ThinJobPayload {
  assertRecord(value);
  assertExactKeys(value, ["tenantId", "deliveryId", "eventId", "route", "jobType", "eventType", "schemaVersion",
    "aggregateType", "aggregateId", "aggregateVersion", "correlationId", "classificationReference", "purposeReference", "policyReference"], ["causationId"]);
  if (![value.tenantId, value.deliveryId, value.eventId, value.aggregateId, value.correlationId].every((item) => uuid.test(String(item)))) throw new Error("INVALID_THIN_JOB");
  if (value.causationId !== undefined && !uuid.test(String(value.causationId))) throw new Error("INVALID_THIN_JOB");
  if (!OUTBOX_ROUTES.includes(value.route as OutboxRoute) || !/^v[1-9][0-9]*$/.test(String(value.schemaVersion))) throw new Error("INVALID_THIN_JOB");
  if (!JOB_TYPES[value.route as OutboxRoute].includes(String(value.jobType))) throw new Error("INVALID_THIN_JOB");
  if (!/^[A-Z][A-Za-z0-9]{2,95}$/.test(String(value.eventType)) || !/^[A-Z][A-Z0-9_]{2,63}$/.test(String(value.aggregateType)) || !Number.isInteger(value.aggregateVersion) || Number(value.aggregateVersion) < 1) throw new Error("INVALID_THIN_JOB");
  if (![value.classificationReference, value.purposeReference].every((item) => /^[A-Z][A-Z0-9_]{2,63}$/.test(String(item))) || !/^[a-z][a-z0-9._-]{2,63}$/.test(String(value.policyReference))) throw new Error("INVALID_THIN_JOB");
  return Object.freeze(value as unknown as ThinJobPayload);
}
