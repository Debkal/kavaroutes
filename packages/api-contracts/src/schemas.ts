import { Type as TypeBox, type Static, type TSchema } from "typebox";

const Type = Object.freeze({
  ...TypeBox,
  Ref<T extends TSchema>(schema: T) {
    const id = (schema as { $id?: unknown }).$id;
    if (typeof id !== "string") throw new Error("REFERENCED_SCHEMA_ID_REQUIRED");
    return TypeBox.Unsafe<Static<T>>({ $ref: id });
  },
});

const closed = { additionalProperties: false } as const;

export const OpaqueIdSchema = Type.String({
  pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
  minLength: 36,
  maxLength: 36,
  $id: "OpaqueId",
});
export const InstantSchema = Type.String({ format: "date-time", maxLength: 35, $id: "Instant" });
export const ServiceDateSchema = Type.String({ pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}$", $id: "ServiceDate" });
export const IanaTimezoneSchema = Type.String({ pattern: "^[A-Za-z_+-]+(?:/[A-Za-z0-9_+.-]+)+$", minLength: 3, maxLength: 64, $id: "IanaTimezone" });
export const IdempotencyKeySchema = Type.String({ pattern: "^[A-Za-z0-9_-]{16,128}$", minLength: 16, maxLength: 128, $id: "IdempotencyKey" });
export const StrongEtagSchema = Type.String({ pattern: "^\"kr1\.[A-Za-z0-9_-]{32,64}\"$", maxLength: 72, $id: "StrongEtag" });

export const ProblemErrorSchema = Type.Object({
  code: Type.String({ pattern: "^[A-Z][A-Z0-9_]{2,63}$", maxLength: 64 }),
  pointer: Type.String({ pattern: "^/(?:[A-Za-z0-9_-]+/?)*$", maxLength: 256 }),
}, { ...closed, $id: "ProblemError" });

export const ProblemSchema = Type.Object({
  type: Type.String({ pattern: "^urn:kavaroutes:problem:[a-z0-9-]{2,64}$", maxLength: 96 }),
  title: Type.String({ minLength: 3, maxLength: 96 }),
  status: Type.Integer({ minimum: 400, maximum: 599 }),
  detail: Type.String({ minLength: 3, maxLength: 256 }),
  instance: Type.String({ pattern: "^urn:kavaroutes:request:[a-z0-9_-]{8,64}$", maxLength: 96 }),
  code: Type.String({ pattern: "^[A-Z][A-Z0-9_]{2,63}$", maxLength: 64 }),
  requestId: Type.String({ pattern: "^[a-z0-9][a-z0-9_-]{7,63}$", maxLength: 64 }),
  errors: Type.Optional(Type.Array(Type.Ref(ProblemErrorSchema), { maxItems: 20 })),
}, { ...closed, $id: "Problem" });

export const OrganizationMembershipSchema = Type.Object({
  organizationId: Type.Ref(OpaqueIdSchema),
  capabilities: Type.Array(Type.String({ pattern: "^[a-z]+(?::[a-z-]+)+$", maxLength: 64 }), { maxItems: 32 }),
}, { ...closed, $id: "OrganizationMembership" });

export const MeResponseSchema = Type.Object({
  principalId: Type.Ref(OpaqueIdSchema),
  principalKind: Type.Union([Type.Literal("SYNTHETIC_USER"), Type.Literal("SYNTHETIC_DEVICE")]),
  organizations: Type.Array(Type.Ref(OrganizationMembershipSchema), { maxItems: 8 }),
  policyVersion: Type.Literal("privacy-synthetic-v1"),
}, { ...closed, $id: "MeResponse" });

export const TripCreateRequestSchema = Type.Object({
  tripId: Type.Ref(OpaqueIdSchema),
  riderId: Type.Ref(OpaqueIdSchema),
  serviceDate: Type.Ref(ServiceDateSchema),
  serviceTimezone: Type.Ref(IanaTimezoneSchema),
  localServiceTime: Type.String({ pattern: "^[0-2][0-9]:[0-5][0-9]:[0-5][0-9]$", maxLength: 8 }),
  resolvedServiceAt: Type.Ref(InstantSchema),
  resolvedUtcOffsetSeconds: Type.Integer({ minimum: -50400, maximum: 50400 }),
  ambiguityPolicy: Type.Union([Type.Literal("reject"), Type.Literal("earlier"), Type.Literal("later")]),
}, { ...closed, $id: "TripCreateRequest" });

export const DispatcherTripSchema = Type.Object({
  tripId: Type.Ref(OpaqueIdSchema),
  riderReference: Type.Ref(OpaqueIdSchema),
  serviceDate: Type.Ref(ServiceDateSchema),
  serviceTimezone: Type.Ref(IanaTimezoneSchema),
  resolvedServiceAt: Type.Ref(InstantSchema),
  lifecycle: Type.Union([Type.Literal("DRAFT"), Type.Literal("CANCELLED")]),
  version: Type.Integer({ minimum: 1 }),
}, { ...closed, $id: "DispatcherTrip" });

export const CommandReceiptSchema = Type.Object({
  command: Type.String({ pattern: "^[A-Z][A-Za-z0-9]{2,63}$", maxLength: 64 }),
  outcome: Type.Union([Type.Literal("APPLIED"), Type.Literal("REPLAYED")]),
  resourceVersion: Type.Integer({ minimum: 1 }),
}, { ...closed, $id: "CommandReceipt" });

export const TripCommandResponseSchema = Type.Object({
  trip: Type.Ref(DispatcherTripSchema),
  receipt: Type.Ref(CommandReceiptSchema),
}, { ...closed, $id: "TripCommandResponse" });

export const CancelTripRequestSchema = Type.Object({
  reasonCode: Type.Union([Type.Literal("SYNTHETIC_REQUESTER_CANCELLED"), Type.Literal("SYNTHETIC_SERVICE_UNAVAILABLE")]),
}, { ...closed, $id: "CancelTripRequest" });

export const PageSchema = Type.Object({
  nextCursor: Type.Union([Type.String({ minLength: 32, maxLength: 2048 }), Type.Null()]),
  asOf: Type.Ref(InstantSchema),
  limit: Type.Integer({ minimum: 1, maximum: 200 }),
}, { ...closed, $id: "Page" });

export const TripCollectionSchema = Type.Object({
  items: Type.Array(Type.Ref(DispatcherTripSchema), { maxItems: 200 }),
  page: Type.Ref(PageSchema),
}, { ...closed, $id: "TripCollection" });

export const RiderSearchRequestSchema = Type.Object({
  syntheticReferencePrefix: Type.String({ pattern: "^synthetic-[a-z0-9-]{1,48}$", minLength: 11, maxLength: 58 }),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 25 })),
}, { ...closed, $id: "RiderSearchRequest" });

export const RiderSearchResultSchema = Type.Object({
  riderId: Type.Ref(OpaqueIdSchema),
  syntheticDisplayLabel: Type.String({ pattern: "^Synthetic Rider [0-9]{1,6}$", maxLength: 32 }),
}, { ...closed, $id: "RiderSearchResult" });

export const RiderSearchResponseSchema = Type.Object({
  items: Type.Array(Type.Ref(RiderSearchResultSchema), { maxItems: 25 }),
}, { ...closed, $id: "RiderSearchResponse" });

export const DispatchDaySchema = Type.Object({
  serviceDate: Type.Ref(ServiceDateSchema),
  serviceTimezone: Type.Ref(IanaTimezoneSchema),
  snapshotVersion: Type.Integer({ minimum: 1 }),
  runs: Type.Array(Type.Object({
    runId: Type.Ref(OpaqueIdSchema),
    plannedStartAt: Type.Ref(InstantSchema),
    plannedEndAt: Type.Ref(InstantSchema),
    lifecycle: Type.String({ pattern: "^[A-Z][A-Z_]{2,31}$", maxLength: 32 }),
  }, closed), { maxItems: 200 }),
}, { ...closed, $id: "DispatchDay" });

export const DriverManifestSchema = Type.Object({
  driverReference: Type.Ref(OpaqueIdSchema),
  serviceDate: Type.Ref(ServiceDateSchema),
  serviceTimezone: Type.Ref(IanaTimezoneSchema),
  version: Type.Integer({ minimum: 1 }),
  assignments: Type.Array(Type.Object({
    assignmentReference: Type.Ref(OpaqueIdSchema),
    stopOrdinal: Type.Integer({ minimum: 1, maximum: 1000 }),
    scheduledAt: Type.Ref(InstantSchema),
    syntheticLocationLabel: Type.String({ pattern: "^Synthetic Stop [0-9]{1,4}$", maxLength: 32 }),
  }, closed), { maxItems: 200 }),
}, { ...closed, $id: "DriverManifest" });

export const DriverActionItemSchema = Type.Object({
  clientActionId: Type.Ref(OpaqueIdSchema),
  deviceEpoch: Type.Integer({ minimum: 1 }),
  sequence: Type.Integer({ minimum: 1 }),
  capturedAt: Type.Ref(InstantSchema),
  command: Type.Union([
    Type.Literal("MARK_EN_ROUTE"), Type.Literal("ARRIVE_PICKUP"), Type.Literal("BOARD_RIDER"),
    Type.Literal("ARRIVE_DROPOFF"), Type.Literal("COMPLETE_LEG"), Type.Literal("REPORT_INCIDENT"),
  ]),
  resourceReference: Type.Ref(OpaqueIdSchema),
  expectedTag: Type.Ref(StrongEtagSchema),
  idempotencyKey: Type.Ref(IdempotencyKeySchema),
}, { ...closed, $id: "DriverActionItem" });

export const DriverActionBatchSchema = Type.Object({
  deviceSessionId: Type.Ref(OpaqueIdSchema),
  items: Type.Array(Type.Ref(DriverActionItemSchema), { minItems: 1, maxItems: 100 }),
}, { ...closed, $id: "DriverActionBatch" });

export const BatchReceiptItemSchema = Type.Object({
  clientItemId: Type.Ref(OpaqueIdSchema),
  outcome: Type.Union([Type.Literal("APPLIED"), Type.Literal("REPLAYED"), Type.Literal("REJECTED")]),
  resourceVersion: Type.Optional(Type.Integer({ minimum: 1 })),
  code: Type.Optional(Type.String({ pattern: "^[A-Z][A-Z0-9_]{2,63}$", maxLength: 64 })),
}, { ...closed, $id: "BatchReceiptItem" });

export const BatchReceiptSchema = Type.Object({
  batchReference: Type.Ref(OpaqueIdSchema),
  items: Type.Array(Type.Ref(BatchReceiptItemSchema), { minItems: 1, maxItems: 500 }),
}, { ...closed, $id: "BatchReceipt" });

export const LocationSampleSchema = Type.Object({
  sampleId: Type.Ref(OpaqueIdSchema),
  deviceEpoch: Type.Integer({ minimum: 1 }),
  sequence: Type.Integer({ minimum: 1 }),
  capturedAt: Type.Ref(InstantSchema),
  longitude: Type.Number({ minimum: -180, maximum: 180 }),
  latitude: Type.Number({ minimum: -90, maximum: 90 }),
}, { ...closed, $id: "LocationSample" });

export const LocationBatchSchema = Type.Object({
  deviceId: Type.Ref(OpaqueIdSchema),
  samples: Type.Array(Type.Ref(LocationSampleSchema), { minItems: 1, maxItems: 500 }),
}, { ...closed, $id: "LocationBatch" });

export const OperationSchema = Type.Object({
  operationId: Type.Ref(OpaqueIdSchema),
  state: Type.Union([Type.Literal("QUEUED"), Type.Literal("RUNNING"), Type.Literal("SUCCEEDED"), Type.Literal("FAILED"), Type.Literal("CANCELLED"), Type.Literal("EXPIRED")]),
  progress: Type.Object({ completed: Type.Integer({ minimum: 0 }), total: Type.Integer({ minimum: 0 }) }, closed),
  createdAt: Type.Ref(InstantSchema),
  updatedAt: Type.Ref(InstantSchema),
  expiresAt: Type.Ref(InstantSchema),
  resultLink: Type.Optional(Type.String({ pattern: "^/v1/organizations/[0-9a-f-]{36}/[A-Za-z0-9/_-]+$", maxLength: 512 })),
  problemLink: Type.Optional(Type.String({ pattern: "^/v1/organizations/[0-9a-f-]{36}/operations/[0-9a-f-]{36}/problem$", maxLength: 512 })),
}, { ...closed, $id: "Operation" });

export const FacilityTripProjectionSchema = Type.Object({
  relatedTripReference: Type.Ref(OpaqueIdSchema),
  lifecycle: Type.String({ pattern: "^[A-Z][A-Z_]{2,31}$", maxLength: 32 }),
  scheduledAt: Type.Ref(InstantSchema),
}, { ...closed, $id: "FacilityTripProjection" });

export const BillingProjectionSchema = Type.Object({
  billingCaseReference: Type.Ref(OpaqueIdSchema),
  amountMinor: Type.Integer({ minimum: 0 }),
  currency: Type.String({ pattern: "^[A-Z]{3}$" }),
  proofRecordedAt: Type.Ref(InstantSchema),
}, { ...closed, $id: "BillingProjection" });

export const AuditProjectionSchema = Type.Object({
  auditReference: Type.Ref(OpaqueIdSchema),
  actionReference: Type.String({ pattern: "^[a-z][a-z0-9.-]{2,63}$", maxLength: 64 }),
  occurredAt: Type.Ref(InstantSchema),
}, { ...closed, $id: "AuditProjection" });

export const IntegrationProjectionSchema = Type.Object({
  receiptReference: Type.Ref(OpaqueIdSchema),
  outcome: Type.Union([Type.Literal("ACCEPTED"), Type.Literal("REJECTED"), Type.Literal("PARTIAL")]),
}, { ...closed, $id: "IntegrationProjection" });

export const allSchemas: readonly TSchema[] = Object.freeze([
  OpaqueIdSchema, InstantSchema, ServiceDateSchema, IanaTimezoneSchema, IdempotencyKeySchema, StrongEtagSchema,
  ProblemErrorSchema, ProblemSchema, OrganizationMembershipSchema, MeResponseSchema, TripCreateRequestSchema,
  DispatcherTripSchema, CommandReceiptSchema, TripCommandResponseSchema, CancelTripRequestSchema, PageSchema,
  TripCollectionSchema, RiderSearchRequestSchema, RiderSearchResultSchema, RiderSearchResponseSchema, DispatchDaySchema,
  DriverManifestSchema, DriverActionItemSchema, DriverActionBatchSchema, BatchReceiptItemSchema, BatchReceiptSchema,
  LocationSampleSchema, LocationBatchSchema, OperationSchema, FacilityTripProjectionSchema, BillingProjectionSchema,
  AuditProjectionSchema, IntegrationProjectionSchema,
]);

export type TripCreateRequest = Static<typeof TripCreateRequestSchema>;
export type DispatcherTrip = Static<typeof DispatcherTripSchema>;
export type CancelTripRequest = Static<typeof CancelTripRequestSchema>;
export type DriverActionBatch = Static<typeof DriverActionBatchSchema>;
export type LocationBatch = Static<typeof LocationBatchSchema>;
export type BatchReceipt = Static<typeof BatchReceiptSchema>;
export type Problem = Static<typeof ProblemSchema>;
