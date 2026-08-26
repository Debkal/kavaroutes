import { Type, type Static, type TSchema } from "typebox";
import { Value } from "typebox/value";
import { parseStrictJson } from "@kavaroutes/api-contracts";

export const REALTIME_PROTOCOL = "kavaroutes.realtime.v1" as const;
export const REALTIME_SCHEMA_VERSION = "realtime.schema.v1" as const;
export const REALTIME_POLICY_VERSION = "realtime.policy.v1" as const;
export const REALTIME_PROJECTION_VERSION = "realtime.projection.v1" as const;

export const REALTIME_LIMITS = Object.freeze({
  maximumInboundBytes: 64 * 1024,
  maximumOutboundBatchBytes: 256 * 1024,
  maximumChangesPerBatch: 100,
  maximumQueuedFrames: 256,
  maximumQueuedBytes: 1024 * 1024,
  maximumSubscriptionsPerConnection: 16,
  maximumConnectionsPerPrincipal: 8,
  maximumJsonDepth: 16,
  maximumStringLength: 4096,
  heartbeatMilliseconds: 30_000,
  deadPeerGraceMilliseconds: 75_000,
  authorizationBackstopMilliseconds: 30_000,
  pollMilliseconds: 1_000,
  materialReplayMilliseconds: 24 * 60 * 60 * 1000,
  locationReplayMilliseconds: 15 * 60 * 1000,
  reconnectFloorMilliseconds: 250,
  reconnectCapMilliseconds: 30_000,
});

const Id = Type.String({ pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$", maxLength: 36 });
const SafeReference = Type.String({ pattern: "^[a-z][a-z0-9:_-]{2,127}$", maxLength: 128 });
const Instant = Type.String({ format: "date-time", maxLength: 35 });
const Cursor = Type.String({ pattern: "^rtc1[.][A-Za-z0-9_-]{48,8192}$", maxLength: 8197 });

export const StreamKindSchema = Type.Union([
  Type.Literal("DISPATCH_DAY"), Type.Literal("DRIVER_MANIFEST"), Type.Literal("FACILITY_DAY"),
  Type.Literal("OPERATION"), Type.Literal("CURRENT_POSITION"),
], { $id: "RealtimeStreamKind" });

export const SubscriptionPurposeSchema = Type.Union([
  Type.Literal("DISPATCH_CONTROL"), Type.Literal("DRIVER_MANIFEST"), Type.Literal("FACILITY_COORDINATION"),
  Type.Literal("OPERATION_PROGRESS"), Type.Literal("DISPATCH_CURRENT_POSITION"),
], { $id: "RealtimeSubscriptionPurpose" });

export const NormalizedScopeSchema = Type.Object({
  streamKind: StreamKindSchema,
  scopeReference: SafeReference,
  serviceDate: Type.Optional(Type.String({ pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}$" })),
  subjectReference: Type.Optional(SafeReference),
  shard: Type.Optional(Type.Integer({ minimum: 0, maximum: 255 })),
}, { additionalProperties: false, $id: "RealtimeNormalizedScope" });

export const InvalidationDeltaSchema = Type.Object({
  kind: Type.Literal("RESOURCE_INVALIDATED"),
  resourceKind: Type.Union([Type.Literal("trip"), Type.Literal("run"), Type.Literal("assignment"), Type.Literal("manifest"), Type.Literal("facility-trip"), Type.Literal("operation")]),
  resourceReference: SafeReference,
  resourceVersion: Type.Integer({ minimum: 1 }),
}, { additionalProperties: false, $id: "RealtimeInvalidationDelta" });

export const DispatcherControlDeltaSchema = Type.Object({
  kind: Type.Literal("DISPATCH_CONTROL"),
  tripReference: SafeReference,
  lifecycle: Type.Union([Type.Literal("SCHEDULED"), Type.Literal("DISPATCHED"), Type.Literal("IN_PROGRESS"), Type.Literal("COMPLETED"), Type.Literal("CANCELLED")]),
  resourceVersion: Type.Integer({ minimum: 1 }),
}, { additionalProperties: false, $id: "RealtimeDispatcherControlDelta" });

export const DriverManifestDeltaSchema = Type.Object({
  kind: Type.Literal("DRIVER_MANIFEST"),
  manifestReference: SafeReference,
  serviceDate: Type.String({ pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}$" }),
  lifecycle: Type.Union([Type.Literal("ASSIGNED"), Type.Literal("UPDATED"), Type.Literal("REMOVED")]),
  resourceVersion: Type.Integer({ minimum: 1 }),
}, { additionalProperties: false, $id: "RealtimeDriverManifestDelta" });

export const FacilityDeltaSchema = Type.Object({
  kind: Type.Literal("FACILITY_COORDINATION"),
  tripReference: SafeReference,
  lifecycle: Type.Union([Type.Literal("PLANNED"), Type.Literal("EN_ROUTE"), Type.Literal("ARRIVED"), Type.Literal("DEPARTED"), Type.Literal("CANCELLED")]),
  resourceVersion: Type.Integer({ minimum: 1 }),
}, { additionalProperties: false, $id: "RealtimeFacilityDelta" });

export const OperationDeltaSchema = Type.Object({
  kind: Type.Literal("OPERATION_PROGRESS"),
  operationReference: SafeReference,
  lifecycle: Type.Union([Type.Literal("QUEUED"), Type.Literal("RUNNING"), Type.Literal("SUCCEEDED"), Type.Literal("FAILED"), Type.Literal("CANCELLED")]),
  resourceVersion: Type.Integer({ minimum: 1 }),
}, { additionalProperties: false, $id: "RealtimeOperationDelta" });

export const CurrentPositionDeltaSchema = Type.Object({
  kind: Type.Literal("CURRENT_POSITION"),
  driverReference: SafeReference,
  latitude: Type.Number({ minimum: -90, maximum: 90 }),
  longitude: Type.Number({ minimum: -180, maximum: 180 }),
  accuracyMeters: Type.Number({ minimum: 0, maximum: 10_000 }),
  capturedAt: Instant,
  resourceVersion: Type.Integer({ minimum: 1 }),
}, { additionalProperties: false, $id: "RealtimeCurrentPositionDelta" });

export const RealtimeDeltaSchema = Type.Union([
  InvalidationDeltaSchema, DispatcherControlDeltaSchema, DriverManifestDeltaSchema,
  FacilityDeltaSchema, OperationDeltaSchema, CurrentPositionDeltaSchema,
], { $id: "RealtimeDelta" });

export const ChangeSchema = Type.Object({
  streamId: Id,
  epoch: Type.Integer({ minimum: 1 }),
  sequence: Type.Integer({ minimum: 1 }),
  schemaVersion: Type.Literal(REALTIME_SCHEMA_VERSION),
  committedAt: Instant,
  delta: RealtimeDeltaSchema,
}, { additionalProperties: false, $id: "RealtimeChange" });

export const SubscribeFrameSchema = Type.Object({
  type: Type.Literal("subscription.subscribe"),
  messageId: SafeReference,
  subscriptionId: SafeReference,
  organizationId: Id,
  purpose: SubscriptionPurposeSchema,
  scope: NormalizedScopeSchema,
  cursor: Type.Optional(Cursor),
}, { additionalProperties: false, $id: "RealtimeSubscribeFrame" });

export const UnsubscribeFrameSchema = Type.Object({
  type: Type.Literal("subscription.unsubscribe"), messageId: SafeReference, subscriptionId: SafeReference,
}, { additionalProperties: false, $id: "RealtimeUnsubscribeFrame" });

export const AckFrameSchema = Type.Object({
  type: Type.Literal("subscription.ack"), messageId: SafeReference, subscriptionId: SafeReference,
  cursor: Cursor,
}, { additionalProperties: false, $id: "RealtimeAckFrame" });

export const ClientFrameSchema = Type.Union([SubscribeFrameSchema, UnsubscribeFrameSchema, AckFrameSchema], { $id: "RealtimeClientFrame" });

export const ConnectionReadyFrameSchema = Type.Object({
  type: Type.Literal("connection.ready"), protocol: Type.Literal(REALTIME_PROTOCOL), connectionId: SafeReference,
  heartbeatMilliseconds: Type.Integer({ minimum: 1 }), deadPeerGraceMilliseconds: Type.Integer({ minimum: 1 }),
  limits: Type.Object({ maximumInboundBytes: Type.Integer(), maximumOutboundBatchBytes: Type.Integer(), maximumChangesPerBatch: Type.Integer(), maximumSubscriptions: Type.Integer() }, { additionalProperties: false }),
}, { additionalProperties: false, $id: "RealtimeConnectionReadyFrame" });

export const ChangeBatchFrameSchema = Type.Object({
  type: Type.Literal("change.batch"), subscriptionId: SafeReference, cursor: Cursor,
  changes: Type.Array(ChangeSchema, { minItems: 1, maxItems: REALTIME_LIMITS.maximumChangesPerBatch }),
}, { additionalProperties: false, $id: "RealtimeChangeBatchFrame" });

const SubscriptionStateFrameSchema = Type.Object({
  type: Type.Union([Type.Literal("subscription.live"), Type.Literal("subscription.reset-required"), Type.Literal("subscription.revoked")]),
  subscriptionId: SafeReference,
  code: Type.Union([Type.Literal("LIVE"), Type.Literal("RESET_REQUIRED"), Type.Literal("AUTHORIZATION_REVOKED")]),
  cursor: Type.Optional(Cursor),
}, { additionalProperties: false, $id: "RealtimeSubscriptionStateFrame" });

export const ServerDrainingFrameSchema = Type.Object({ type: Type.Literal("server.draining"), code: Type.Literal("SERVER_DRAINING") }, { additionalProperties: false, $id: "RealtimeServerDrainingFrame" });
export const ProtocolErrorFrameSchema = Type.Object({
  type: Type.Literal("protocol.error"), code: Type.Union([
    Type.Literal("FRAME_INVALID"), Type.Literal("FRAME_TOO_LARGE"), Type.Literal("RATE_LIMITED"),
    Type.Literal("SUBSCRIPTION_LIMIT"), Type.Literal("AUTHORIZATION_DENIED"), Type.Literal("CURSOR_INVALID"),
    Type.Literal("SLOW_CONSUMER"), Type.Literal("INTERNAL_ERROR"),
  ]),
}, { additionalProperties: false, $id: "RealtimeProtocolErrorFrame" });

export const ServerFrameSchema = Type.Union([
  ConnectionReadyFrameSchema, ChangeBatchFrameSchema, SubscriptionStateFrameSchema,
  ServerDrainingFrameSchema, ProtocolErrorFrameSchema,
], { $id: "RealtimeServerFrame" });

export const ChangeQueryRequestSchema = Type.Object({
  purpose: SubscriptionPurposeSchema, scope: NormalizedScopeSchema, cursor: Cursor,
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: REALTIME_LIMITS.maximumChangesPerBatch })),
}, { additionalProperties: false, $id: "RealtimeChangeQueryRequest" });

export const ChangeQueryResponseSchema = Type.Object({
  outcome: Type.Union([Type.Literal("REPLAY"), Type.Literal("RESET_REQUIRED")]),
  cursor: Type.Optional(Cursor), changes: Type.Array(ChangeSchema, { maxItems: REALTIME_LIMITS.maximumChangesPerBatch }),
}, { additionalProperties: false, $id: "RealtimeChangeQueryResponse" });

export const SnapshotSchema = Type.Object({
  projection: Type.Record(SafeReference, Type.Unknown()), etag: Type.String({ pattern: "^\"rt1[.][A-Za-z0-9_-]{32,64}\"$" }), cursor: Cursor,
}, { additionalProperties: false, $id: "RealtimeSnapshot" });

export const realtimeSchemas: readonly TSchema[] = Object.freeze([
  StreamKindSchema, SubscriptionPurposeSchema, NormalizedScopeSchema, InvalidationDeltaSchema,
  DispatcherControlDeltaSchema, DriverManifestDeltaSchema, FacilityDeltaSchema, OperationDeltaSchema,
  CurrentPositionDeltaSchema, RealtimeDeltaSchema, ChangeSchema, SubscribeFrameSchema,
  UnsubscribeFrameSchema, AckFrameSchema, ClientFrameSchema, ConnectionReadyFrameSchema,
  ChangeBatchFrameSchema, SubscriptionStateFrameSchema, ServerDrainingFrameSchema,
  ProtocolErrorFrameSchema, ServerFrameSchema, ChangeQueryRequestSchema, ChangeQueryResponseSchema, SnapshotSchema,
]);

export type StreamKind = Static<typeof StreamKindSchema>;
export type SubscriptionPurpose = Static<typeof SubscriptionPurposeSchema>;
export type NormalizedScope = Static<typeof NormalizedScopeSchema>;
export type RealtimeDelta = Static<typeof RealtimeDeltaSchema>;
export type RealtimeChange = Static<typeof ChangeSchema>;
export type ClientFrame = Static<typeof ClientFrameSchema>;
export type ServerFrame = Static<typeof ServerFrameSchema>;
export type ChangeQueryRequest = Static<typeof ChangeQueryRequestSchema>;
export type ChangeQueryResponse = Static<typeof ChangeQueryResponseSchema>;

export class RealtimeProtocolError extends Error {
  constructor(readonly code: "FRAME_INVALID" | "FRAME_TOO_LARGE" | "RATE_LIMITED" | "SUBSCRIPTION_LIMIT" | "AUTHORIZATION_DENIED" | "CURSOR_INVALID" | "SLOW_CONSUMER" | "INTERNAL_ERROR") {
    super(code);
    this.name = "RealtimeProtocolError";
  }
}

export function decodeClientFrame(raw: string | Buffer): ClientFrame {
  const bytes = Buffer.byteLength(raw);
  if (bytes > REALTIME_LIMITS.maximumInboundBytes) throw new RealtimeProtocolError("FRAME_TOO_LARGE");
  let value: unknown;
  try { value = parseStrictJson(raw.toString(), REALTIME_LIMITS.maximumJsonDepth); }
  catch { throw new RealtimeProtocolError("FRAME_INVALID"); }
  if (!Value.Check(ClientFrameSchema, value)) throw new RealtimeProtocolError("FRAME_INVALID");
  return value;
}

export function assertServerFrame(value: unknown): asserts value is ServerFrame {
  if (!Value.Check(ServerFrameSchema, value)) throw new Error("SERVER_FRAME_SCHEMA_DIVERGENCE");
}

export const REALTIME_CLOSE_CODES = Object.freeze({
  NORMAL: { code: 1000, reason: "NORMAL" }, GOING_AWAY: { code: 1001, reason: "GOING_AWAY" },
  PROTOCOL: { code: 1002, reason: "PROTOCOL_ERROR" }, UNSUPPORTED: { code: 1003, reason: "UNSUPPORTED_FRAME" },
  INVALID: { code: 1007, reason: "INVALID_PAYLOAD" }, POLICY: { code: 1008, reason: "POLICY_VIOLATION" },
  TOO_LARGE: { code: 1009, reason: "FRAME_TOO_LARGE" }, INTERNAL: { code: 1011, reason: "INTERNAL_ERROR" },
  RESTART: { code: 1012, reason: "SERVICE_RESTART" }, RETRY: { code: 1013, reason: "TRY_AGAIN_LATER" },
});

export const PROTOCOL_CATALOG = Object.freeze({
  protocol: REALTIME_PROTOCOL,
  privateProtocol: true,
  ianaRegistered: false,
  compatibility: [{ protocol: REALTIME_PROTOCOL, schema: REALTIME_SCHEMA_VERSION, projection: REALTIME_PROJECTION_VERSION, policy: REALTIME_POLICY_VERSION, status: "CURRENT" }],
  clientFrames: ["subscription.subscribe", "subscription.unsubscribe", "subscription.ack"],
  serverFrames: ["connection.ready", "change.batch", "subscription.live", "subscription.reset-required", "subscription.revoked", "server.draining", "protocol.error"],
  limits: REALTIME_LIMITS,
  closeCodes: REALTIME_CLOSE_CODES,
  examples: {
    subscribe: { type: "subscription.subscribe", messageId: "message:synthetic:001", subscriptionId: "subscription:synthetic:001", organizationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", purpose: "DISPATCH_CONTROL", scope: { streamKind: "DISPATCH_DAY", scopeReference: "dispatch:synthetic:2026-08-25", serviceDate: "2026-08-25" } },
    error: { type: "protocol.error", code: "FRAME_INVALID" },
  },
});
