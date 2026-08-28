import { Type, type Static } from "typebox";

const Closed = { additionalProperties: false } as const;
export const DRIVER_POLICY_VERSION = "driver-synthetic-v1" as const;

export const DriverSyncStateSchema = Type.Union([
  Type.Literal("DISCONNECTED"), Type.Literal("RECONNECTING"), Type.Literal("AUTHENTICATING"), Type.Literal("SNAPSHOT_REQUIRED"),
  Type.Literal("REPLAYING"), Type.Literal("LIVE"), Type.Literal("STALE"), Type.Literal("STOPPED"), Type.Literal("OFFLINE_QUEUE_PENDING"),
  Type.Literal("UPLOADING"), Type.Literal("CONFLICT"), Type.Literal("REAUTH_REQUIRED"),
], { $id: "DriverSyncState" });
export type DriverSyncState = Static<typeof DriverSyncStateSchema>;

export const TrackingStateSchema = Type.Union([
  Type.Literal("NOT_CONFIGURED"), Type.Literal("PERMISSION_REQUIRED"), Type.Literal("READY"), Type.Literal("STARTING"),
  Type.Literal("TRACKING"), Type.Literal("DEGRADED_APPROXIMATE"), Type.Literal("PAUSED_BY_SYSTEM"), Type.Literal("STOPPED_BY_DRIVER"),
  Type.Literal("REVOKED"), Type.Literal("STALE"), Type.Literal("ERROR"),
], { $id: "DriverTrackingState" });
export type TrackingState = Static<typeof TrackingStateSchema>;

export const DriverRouteSchema = Type.Union([
  Type.Literal("SHIFT_HOME"), Type.Literal("MANIFEST"), Type.Literal("STOP_DETAIL"), Type.Literal("INSPECTION"),
  Type.Literal("SIGNATURE"), Type.Literal("PROPOSAL"), Type.Literal("RETURN"), Type.Literal("SYNC"), Type.Literal("DIAGNOSTICS"),
], { $id: "DriverRoute" });
export type DriverRoute = Static<typeof DriverRouteSchema>;

export const DriverActionSchema = Type.Object({
  actionId: Type.String({ format: "uuid" }),
  idempotencyKey: Type.String({ pattern: "^[A-Za-z0-9_-]{16,128}$" }),
  fingerprint: Type.String({ pattern: "^[a-f0-9]{64}$" }),
  resourceReference: Type.String({ format: "uuid" }),
  expectedVersion: Type.Integer({ minimum: 1 }),
  expectedTag: Type.String({ pattern: '^"kr1[.][A-Za-z0-9_-]{32,64}"$' }),
  causalSequence: Type.Integer({ minimum: 1 }),
  deviceEpoch: Type.Integer({ minimum: 1 }),
  sequence: Type.Integer({ minimum: 1 }),
  capturedAt: Type.String({ format: "date-time" }),
  command: Type.Literal("ARRIVE_PICKUP"),
  state: Type.Union([Type.Literal("PENDING"), Type.Literal("UPLOADING"), Type.Literal("ACCEPTED"), Type.Literal("CONFLICT"), Type.Literal("PERMANENT_REJECTION"), Type.Literal("UNKNOWN")]),
  attempt: Type.Integer({ minimum: 0, maximum: 8 }),
  nextAttemptAt: Type.String({ format: "date-time" }),
}, { $id: "DriverAction", ...Closed });
export type DriverAction = Static<typeof DriverActionSchema>;

export const LocationSampleSchema = Type.Object({
  sampleId: Type.String({ pattern: "^loc_[a-z0-9]{16,64}$" }),
  epoch: Type.Integer({ minimum: 1 }),
  sequence: Type.Integer({ minimum: 1 }),
  capturedAt: Type.String({ format: "date-time" }),
  latitude: Type.Number({ minimum: -90, maximum: 90 }),
  longitude: Type.Number({ minimum: -180, maximum: 180 }),
  accuracyMeters: Type.Number({ minimum: 0, maximum: 10000 }),
  policyVersion: Type.Literal(DRIVER_POLICY_VERSION),
}, { $id: "DriverLocationSample", ...Closed });
export type DriverLocationSample = Static<typeof LocationSampleSchema>;

export const EvidenceDraftSchema = Type.Object({
  draftId: Type.String({ pattern: "^evd_[a-z0-9]{16,64}$" }),
  kind: Type.Union([Type.Literal("INSPECTION"), Type.Literal("SIGNATURE")]),
  digest: Type.String({ pattern: "^[a-f0-9]{64}$" }),
  state: Type.Union([Type.Literal("DRAFT"), Type.Literal("QUEUED"), Type.Literal("UPLOADING"), Type.Literal("ACCEPTED"), Type.Literal("REJECTED"), Type.Literal("SUPERSEDED")]),
  createdAt: Type.String({ format: "date-time" }),
}, { $id: "DriverEvidenceDraft", ...Closed });
export type EvidenceDraft = Static<typeof EvidenceDraftSchema>;

export const SamplingPolicySchema = Type.Object({
  version: Type.Literal(DRIVER_POLICY_VERSION),
  foregroundSeconds: Type.Union([Type.Literal(5), Type.Literal(10), Type.Literal(15)]),
  movingBackgroundSeconds: Type.Union([Type.Literal(10), Type.Literal(15), Type.Literal(30)]),
  stationarySeconds: Type.Union([Type.Literal(30), Type.Literal(60), Type.Literal(120)]),
  maximumBatchItems: Type.Literal(500),
  maximumBatchBytes: Type.Literal(1_048_576),
  staleAfterSeconds: Type.Literal(60),
}, { $id: "DriverSamplingPolicy", ...Closed });
export type SamplingPolicy = Static<typeof SamplingPolicySchema>;

export const DEFAULT_SAMPLING_POLICY: SamplingPolicy = Object.freeze({ version: DRIVER_POLICY_VERSION, foregroundSeconds: 10,
  movingBackgroundSeconds: 15, stationarySeconds: 60, maximumBatchItems: 500, maximumBatchBytes: 1_048_576, staleAfterSeconds: 60 });

export const driverSchemas = Object.freeze([DriverSyncStateSchema, TrackingStateSchema, DriverRouteSchema, DriverActionSchema,
  LocationSampleSchema, EvidenceDraftSchema, SamplingPolicySchema]);
