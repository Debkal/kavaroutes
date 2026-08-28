import { createHash, randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { createPostgresPersistence, type JsonValue, type StoredMutationResult } from "@kavaroutes/postgres-persistence";
import type { BatchReceipt, DispatcherTrip, DriverActionBatch, LocationBatch, TripCreateRequest } from "./schemas.js";
import { ProtocolError, requestFingerprint, strongEtag } from "./protocol.js";
import type { SyntheticPrincipal } from "./security.js";
import { syntheticIds } from "./security.js";

export interface TripHttpResult<T> extends StoredMutationResult<T> {}

export interface Wp007Application {
  createTrip(input: { organizationId: string; principal: SyntheticPrincipal; key: string; request: TripCreateRequest }): Promise<TripHttpResult<DispatcherTrip>>;
  readTrip(organizationId: string, tripId: string): Promise<DispatcherTrip | null>;
  listTrips(organizationId: string, input: { afterId?: string; limit: number }): Promise<readonly DispatcherTrip[]>;
  searchRiders(organizationId: string, prefix: string, limit: number): Promise<readonly { riderId: string; syntheticDisplayLabel: string }[]>;
  cancelTrip(input: { organizationId: string; principal: SyntheticPrincipal; tripId: string; key: string; ifMatch: string; request: JsonValue }): Promise<TripHttpResult<{ trip: DispatcherTrip; receipt: { command: string; outcome: "APPLIED" | "REPLAYED"; resourceVersion: number } }>>;
  readDispatchDay(organizationId: string, serviceDate: string): Promise<readonly { runId: string; serviceTimezone: string; plannedStartAt: string; plannedEndAt: string; lifecycle: string; version: number }[]>;
  etag(resourceId: string, version: number, projection: string): string;
}

export interface PostgresApplicationOptions {
  readonly etagSecret: string;
  readonly now?: () => Date;
  readonly idFactory?: () => string;
  readonly failurePoint?: "before-audit" | "before-outbox-message" | "before-outbox-deliveries" | "after-first-outbox-delivery" | "before-commit";
}

function toDispatcherTrip(value: { tripId: string; riderId: string; serviceDate: string; serviceTimezone: string; resolvedServiceAt: string; lifecycle: "DRAFT" | "CANCELLED"; version: number }): DispatcherTrip {
  return {
    tripId: value.tripId, riderReference: value.riderId, serviceDate: value.serviceDate,
    serviceTimezone: value.serviceTimezone, resolvedServiceAt: value.resolvedServiceAt,
    lifecycle: value.lifecycle, version: value.version,
  };
}

export function createWp007PostgresApplication(pool: Pool, options: PostgresApplicationOptions): Wp007Application {
  if (!/^synthetic-etag-secret-[A-Za-z0-9_-]{16,}$/.test(options.etagSecret)) throw new Error("TEST_ETAG_SECRET_REQUIRED");
  const persistence = createPostgresPersistence(pool);
  const now = options.now ?? (() => new Date());
  const idFactory = options.idFactory ?? randomUUID;
  const application: Wp007Application = {
    etag: (resourceId, version, projection) => strongEtag(options.etagSecret, resourceId, version, projection),
    async createTrip(input) {
      const fingerprint = requestFingerprint(input.request);
      const result = await persistence.executeIdempotentMutation({
        tenantId: input.organizationId, actorReference: input.principal.id, operationId: "createTrip",
        key: input.key, fingerprint, recordId: idFactory(), expiresAt: new Date(now().getTime() + 86_700_000),
        failBeforeCommit: options.failurePoint === "before-commit",
      }, async (transaction) => {
        const created = await transaction.createTripDraft({
          tripId: input.request.tripId, riderId: input.request.riderId, serviceDate: input.request.serviceDate,
          serviceTimezone: input.request.serviceTimezone, localServiceTime: input.request.localServiceTime,
          resolvedServiceAt: new Date(input.request.resolvedServiceAt), resolvedUtcOffsetSeconds: input.request.resolvedUtcOffsetSeconds,
          ambiguityPolicy: input.request.ambiguityPolicy,
        });
        if (options.failurePoint === "before-audit") throw new Error("SYNTHETIC_FAILURE_BEFORE_AUDIT");
        await transaction.appendAudit({ auditId: idFactory(), aggregateKind: "trip_request", aggregateId: created.tripId,
          aggregateVersion: created.version, actionReference: "trip.created", actorReference: input.principal.id });
        if (options.failurePoint === "before-outbox-message") throw new Error("SYNTHETIC_FAILURE_BEFORE_OUTBOX_MESSAGE");
        const messageId = idFactory();
        const eventId = idFactory();
        const commandId = idFactory();
        const correlationId = idFactory();
        const recordedAt = now();
        await transaction.appendOutboxMessage({
          messageId, eventId, aggregateType: "TRIP_REQUEST", aggregateId: created.tripId, aggregateVersion: created.version,
          eventType: "TripCreated", schemaVersion: "v1", occurredAt: recordedAt, commandId,
          idempotencyReferenceHash: fingerprint, correlationId, source: "kavaroutes.api", classificationReference: "REGULATED_HEALTH",
          purposeReference: "RIDER_INTAKE", policyReference: "privacy-synthetic-v1",
          payload: { tripId: created.tripId, lifecycle: created.lifecycle, version: created.version },
          retainUntil: new Date(recordedAt.getTime() + 2_592_300_000),
        });
        if (options.failurePoint === "before-outbox-deliveries") throw new Error("SYNTHETIC_FAILURE_BEFORE_OUTBOX_DELIVERIES");
        await transaction.appendOutboxDelivery({ deliveryId: idFactory(), messageId, route: "projection", jobType: "kr.projection.trip.v1", availableAt: recordedAt, retainUntil: new Date(recordedAt.getTime() + 2_592_300_000) });
        if (options.failurePoint === "after-first-outbox-delivery") throw new Error("SYNTHETIC_FAILURE_AFTER_FIRST_OUTBOX_DELIVERY");
        await transaction.appendOutboxDelivery({ deliveryId: idFactory(), messageId, route: "realtime-signal", jobType: "kr.realtime-signal.trip.v1", availableAt: recordedAt, retainUntil: new Date(recordedAt.getTime() + 2_592_300_000) });
        const body = toDispatcherTrip(created);
        return { statusCode: 201, body, headers: {
          location: `/v1/organizations/${input.organizationId}/trips/${created.tripId}`,
          etag: strongEtag(options.etagSecret, created.tripId, created.version, "dispatcher-trip-v1"),
        }, resultReference: created.tripId };
      });
      return result;
    },
    async readTrip(organizationId, tripId) {
      const value = await persistence.readTrip(organizationId, tripId);
      return value ? toDispatcherTrip(value) : null;
    },
    async listTrips(organizationId, input) {
      return (await persistence.listTrips(organizationId, input)).map(toDispatcherTrip);
    },
    async searchRiders(organizationId, prefix, limit) {
      const riders = await persistence.searchSyntheticRiders(organizationId, prefix, limit);
      return riders.map((rider, index) => ({ riderId: rider.riderId, syntheticDisplayLabel: `Synthetic Rider ${index + 1}` }));
    },
    async cancelTrip(input) {
      const fingerprint = requestFingerprint({ tripId: input.tripId, ifMatch: input.ifMatch, request: input.request });
      const result = await persistence.executeIdempotentMutation({
        tenantId: input.organizationId, actorReference: input.principal.id, operationId: "cancelTrip", key: input.key,
        fingerprint, recordId: idFactory(), expiresAt: new Date(now().getTime() + 86_700_000),
        failBeforeCommit: options.failurePoint === "before-commit",
      }, async (transaction) => {
        const current = await transaction.readTrip(input.tripId);
        if (!current) throw new ProtocolError(404, "RESOURCE_NOT_FOUND", "resource hidden");
        const expectedTag = strongEtag(options.etagSecret, current.tripId, current.version, "dispatcher-trip-v1");
        if (input.ifMatch !== expectedTag) throw new ProtocolError(412, "PRECONDITION_FAILED", "stale tag");
        if (current.lifecycle === "CANCELLED") throw new ProtocolError(409, "TRIP_ALREADY_CANCELLED", "trip already cancelled");
        const changed = await transaction.updateTripLifecycle({ tripId: input.tripId, expectedVersion: current.version, lifecycleReference: "cancelled" });
        if (options.failurePoint === "before-audit") throw new Error("SYNTHETIC_FAILURE_BEFORE_AUDIT");
        await transaction.appendAudit({ auditId: idFactory(), aggregateKind: "trip_request", aggregateId: changed.tripId,
          aggregateVersion: changed.version, actionReference: "trip.cancelled", actorReference: input.principal.id });
        if (options.failurePoint === "before-outbox-message") throw new Error("SYNTHETIC_FAILURE_BEFORE_OUTBOX_MESSAGE");
        const messageId = idFactory();
        const eventId = idFactory();
        const commandId = idFactory();
        const correlationId = idFactory();
        const recordedAt = now();
        await transaction.appendOutboxMessage({
          messageId, eventId, aggregateType: "TRIP_REQUEST", aggregateId: changed.tripId, aggregateVersion: changed.version,
          eventType: "TripCancelled", schemaVersion: "v1", occurredAt: recordedAt, commandId,
          idempotencyReferenceHash: fingerprint, correlationId, source: "kavaroutes.api", classificationReference: "REGULATED_HEALTH",
          purposeReference: "RIDER_INTAKE", policyReference: "privacy-synthetic-v1",
          payload: { tripId: changed.tripId, lifecycle: changed.lifecycle, version: changed.version },
          retainUntil: new Date(recordedAt.getTime() + 2_592_300_000),
        });
        if (options.failurePoint === "before-outbox-deliveries") throw new Error("SYNTHETIC_FAILURE_BEFORE_OUTBOX_DELIVERIES");
        await transaction.appendOutboxDelivery({ deliveryId: idFactory(), messageId, route: "projection", jobType: "kr.projection.trip.v1", availableAt: recordedAt, retainUntil: new Date(recordedAt.getTime() + 2_592_300_000) });
        if (options.failurePoint === "after-first-outbox-delivery") throw new Error("SYNTHETIC_FAILURE_AFTER_FIRST_OUTBOX_DELIVERY");
        await transaction.appendOutboxDelivery({ deliveryId: idFactory(), messageId, route: "realtime-signal", jobType: "kr.realtime-signal.trip.v1", availableAt: recordedAt, retainUntil: new Date(recordedAt.getTime() + 2_592_300_000) });
        const trip = toDispatcherTrip(changed);
        const body = { trip, receipt: { command: "CancelTrip", outcome: "APPLIED" as const, resourceVersion: trip.version } };
        return { statusCode: 200, body, headers: { etag: strongEtag(options.etagSecret, trip.tripId, trip.version, "dispatcher-trip-v1") }, resultReference: trip.tripId };
      });
      if (result.replayed) {
        return { ...result, body: { ...result.body, receipt: { ...result.body.receipt, outcome: "REPLAYED" as const } } };
      }
      return result;
    },
    readDispatchDay: (organizationId, serviceDate) => persistence.readDispatchDay(organizationId, serviceDate),
  };
  return Object.freeze(application);
}

export function createDocumentationApplication(etagSecret: string): Wp007Application {
  const application: Wp007Application = {
    etag: (resourceId, version, projection) => strongEtag(etagSecret, resourceId, version, projection),
    createTrip: async () => { throw new Error("DOCUMENTATION_ADAPTER_NOT_EXECUTABLE"); },
    readTrip: async () => null,
    listTrips: async () => [],
    searchRiders: async () => [],
    cancelTrip: async () => { throw new Error("DOCUMENTATION_ADAPTER_NOT_EXECUTABLE"); },
    readDispatchDay: async () => [],
  };
  return Object.freeze(application);
}

interface MemoryEntry<T> { state: "IN_PROGRESS" | "COMMITTED"; fingerprint: string; result?: T; }

export function createOfflineBatchService(now: () => Date = () => new Date()) {
  const operations = new Map<string, MemoryEntry<BatchReceipt>>();
  const itemReceipts = new Map<string, BatchReceipt["items"][number]>();
  const lastSequence = new Map<string, number>();
  async function execute<T extends DriverActionBatch | LocationBatch>(scope: string, key: string, body: T, items: readonly { id: string; epoch: number; sequence: number; rejectionCode?: string }[]): Promise<{ replayed: boolean; receipt: BatchReceipt }> {
    const fingerprint = requestFingerprint(body);
    const operationKey = `${scope}:${key}`;
    const existing = operations.get(operationKey);
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw new ProtocolError(422, "IDEMPOTENCY_KEY_REUSED", "idempotency fingerprint differs");
      if (existing.state === "IN_PROGRESS" || !existing.result) throw new ProtocolError(409, "IDEMPOTENCY_IN_PROGRESS", "operation unresolved", { retryAfterSeconds: 1 });
      return { replayed: true, receipt: existing.result };
    }
    operations.set(operationKey, { state: "IN_PROGRESS", fingerprint });
    await Promise.resolve();
    const receipts = items.map((item) => {
      const itemKey = `${scope}:${item.id}`;
      const previous = itemReceipts.get(itemKey);
      if (previous) return { ...previous, outcome: "REPLAYED" as const };
      const sequenceKey = `${scope}:${item.epoch}`;
      const priorSequence = lastSequence.get(sequenceKey) ?? 0;
      const receipt: BatchReceipt["items"][number] = item.rejectionCode
        ? { clientItemId: item.id, outcome: "REJECTED", code: item.rejectionCode }
        : item.sequence <= priorSequence
        ? { clientItemId: item.id, outcome: "REJECTED", code: "OUT_OF_ORDER_SEQUENCE" }
        : { clientItemId: item.id, outcome: "APPLIED", resourceVersion: item.sequence };
      if (receipt.outcome === "APPLIED") lastSequence.set(sequenceKey, item.sequence);
      itemReceipts.set(itemKey, receipt);
      return receipt;
    });
    const batchReference = deterministicUuid(`${scope}:${key}:${now().toISOString().slice(0, 10)}`);
    const receipt = { batchReference, items: receipts } satisfies BatchReceipt;
    operations.set(operationKey, { state: "COMMITTED", fingerprint, result: receipt });
    return { replayed: false, receipt };
  }
  return Object.freeze({
    actions(scope: string, key: string, batch: DriverActionBatch, validate?: (item: DriverActionBatch["items"][number]) => string | undefined) {
      return execute(scope, key, batch, batch.items.map((item) => {
        const rejectionCode = validate?.(item); const identity = { id: item.clientActionId, epoch: item.deviceEpoch, sequence: item.sequence };
        return rejectionCode ? { ...identity, rejectionCode } : identity;
      }));
    },
    locations(scope: string, key: string, batch: LocationBatch) {
      return execute(scope, key, batch, batch.samples.map((sample) => ({ id: sample.sampleId, epoch: sample.deviceEpoch, sequence: sample.sequence })));
    },
  });
}

function deterministicUuid(value: string): string {
  const hex = createHash("sha256").update(value).digest("hex").slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20)}`;
}

export const syntheticReadModels = Object.freeze({
  manifest: {
    driverReference: syntheticIds.driverSubject, serviceDate: "2026-08-24", serviceTimezone: "America/Los_Angeles",
    version: 3, assignments: [{ assignmentReference: "40000000-0000-4000-8000-000000000001", stopOrdinal: 1,
      scheduledAt: "2026-08-24T15:00:00.000Z", syntheticLocationLabel: "Synthetic Stop 1" }],
  },
  operation: {
    operationId: "50000000-0000-4000-8000-000000000001", state: "RUNNING", progress: { completed: 2, total: 5 },
    createdAt: "2026-08-24T12:00:00.000Z", updatedAt: "2026-08-24T12:01:00.000Z", expiresAt: "2026-08-25T12:00:00.000Z",
  },
});
