import { createHash } from "node:crypto";
import { Value } from "typebox/value";
import type { AuthorizedSubscription } from "./authorization.js";
import { assertDeltaAuthorized } from "./authorization.js";
import { REALTIME_LIMITS, REALTIME_SCHEMA_VERSION, RealtimeDeltaSchema, type ChangeQueryResponse, type NormalizedScope, type RealtimeChange, type RealtimeDelta, type SubscriptionPurpose } from "./contracts.js";
import type { CursorBinding, CursorVector, TestOnlyCursorCodec } from "./cursor.js";
import { CursorRejected } from "./cursor.js";

interface StreamState {
  readonly id: string;
  readonly organizationId: string;
  readonly purpose: SubscriptionPurpose;
  readonly scope: NormalizedScope;
  epoch: number;
  sequence: number;
  minimumSequence: number;
  readonly changes: RealtimeChange[];
  readonly projection: Map<string, RealtimeDelta>;
  readonly coalesceIndex: Map<string, number>;
}

export interface RealtimeAppend {
  readonly organizationId: string;
  readonly sourceEventId: string;
  readonly purpose: SubscriptionPurpose;
  readonly scope: NormalizedScope;
  readonly delta: RealtimeDelta;
  readonly committedAt?: Date;
  readonly coalesceWindowMilliseconds?: number;
}

export interface SnapshotResult {
  readonly projection: Readonly<Record<string, RealtimeDelta>>;
  readonly etag: string;
  readonly cursor: string;
}

export interface RealtimeStore {
  snapshot(authorization: AuthorizedSubscription): Promise<SnapshotResult>;
  replay(authorization: AuthorizedSubscription, cursor: string, limit?: number): Promise<ChangeQueryResponse>;
}

export const SELECTED_LOCATION_SHARDS = 16 as const;

function stableUuid(value: string): string {
  const hex = createHash("sha256").update(value).digest("hex").slice(0, 32).split("");
  hex[12] = "4";
  hex[16] = ["8", "9", "a", "b"][Number.parseInt(hex[16] ?? "0", 16) % 4] ?? "8";
  return `${hex.slice(0, 8).join("")}-${hex.slice(8, 12).join("")}-${hex.slice(12, 16).join("")}-${hex.slice(16, 20).join("")}-${hex.slice(20).join("")}`;
}

function canonicalScope(scope: NormalizedScope, includeShard = true): string {
  const entries = Object.entries(scope).filter(([key]) => includeShard || key !== "shard").sort(([left], [right]) => left.localeCompare(right));
  return JSON.stringify(Object.fromEntries(entries));
}

function streamKey(organizationId: string, purpose: SubscriptionPurpose, scope: NormalizedScope): string {
  return `${organizationId}:${purpose}:${canonicalScope(scope)}`;
}

function bindingFor(authorization: AuthorizedSubscription): CursorBinding {
  return { organizationId: authorization.organizationId, principalId: authorization.principalId,
    authorizationGeneration: authorization.authorizationGeneration, purpose: authorization.purpose, scope: authorization.scope };
}

function deltaResourceKey(delta: RealtimeDelta): string {
  if (delta.kind === "CURRENT_POSITION") return `driver:${delta.driverReference}`;
  if (delta.kind === "DRIVER_MANIFEST") return `manifest:${delta.manifestReference}`;
  if (delta.kind === "OPERATION_PROGRESS") return `operation:${delta.operationReference}`;
  return `resource:${"resourceReference" in delta ? delta.resourceReference : delta.tripReference}`;
}

function matches(stream: StreamState, authorization: AuthorizedSubscription): boolean {
  if (stream.organizationId !== authorization.organizationId || stream.purpose !== authorization.purpose) return false;
  if (authorization.scope.streamKind === "CURRENT_POSITION") return canonicalScope(stream.scope, false) === canonicalScope(authorization.scope, false);
  return canonicalScope(stream.scope) === canonicalScope(authorization.scope);
}

function cursorLifetime(scope: NormalizedScope): number {
  return scope.streamKind === "CURRENT_POSITION" ? REALTIME_LIMITS.locationReplayMilliseconds : REALTIME_LIMITS.materialReplayMilliseconds;
}

export function createInMemoryRealtimeStore(codec: TestOnlyCursorCodec, options: { readonly now?: () => Date; readonly locationShardCount?: number } = {}) {
  const streams = new Map<string, StreamState>();
  const consumedEvents = new Set<string>();
  const now = options.now ?? (() => new Date());
  const locationShardCount = options.locationShardCount ?? SELECTED_LOCATION_SHARDS;
  if (!Number.isInteger(locationShardCount) || locationShardCount < 1 || locationShardCount > 256 || (locationShardCount & (locationShardCount - 1)) !== 0) throw new Error("LOCATION_SHARD_COUNT_INVALID");
  let coalescedSamples = 0;

  function matchingStreams(authorization: AuthorizedSubscription, create: boolean): StreamState[] {
    let result = [...streams.values()].filter((stream) => matches(stream, authorization));
    if (result.length === 0 && create) {
      const shards = authorization.scope.streamKind === "CURRENT_POSITION" && authorization.scope.shard === undefined
        ? Array.from({ length: locationShardCount }, (_, shard) => shard) : [authorization.scope.shard];
      result = shards.map((shard) => {
        const scope = Object.freeze({ ...authorization.scope, ...(shard === undefined ? {} : { shard }) });
        const key = streamKey(authorization.organizationId, authorization.purpose, scope);
        const state: StreamState = { id: stableUuid(key), organizationId: authorization.organizationId, purpose: authorization.purpose,
          scope, epoch: 1, sequence: 0, minimumSequence: 1, changes: [], projection: new Map(), coalesceIndex: new Map() };
        streams.set(key, state);
        return state;
      });
    }
    return result.sort((left, right) => left.id.localeCompare(right.id));
  }

  function issue(authorization: AuthorizedSubscription, vectors: readonly CursorVector[]): string {
    return codec.encode({ organizationId: authorization.organizationId, principalId: authorization.principalId,
      authorizationGeneration: authorization.authorizationGeneration, purpose: authorization.purpose, scope: authorization.scope,
      vectors, lifetimeMilliseconds: cursorLifetime(authorization.scope) });
  }

  async function append(input: RealtimeAppend): Promise<"APPLIED" | "DUPLICATE" | "COALESCED"> {
    const eventKey = `${input.organizationId}:${input.sourceEventId}`;
    if (consumedEvents.has(eventKey)) return "DUPLICATE";
    if (!Value.Check(RealtimeDeltaSchema, input.delta)) throw new Error("REALTIME_DELTA_SCHEMA_INVALID");
    const key = streamKey(input.organizationId, input.purpose, input.scope);
    let stream = streams.get(key);
    if (!stream) {
      stream = { id: stableUuid(key), organizationId: input.organizationId, purpose: input.purpose, scope: Object.freeze({ ...input.scope }),
        epoch: 1, sequence: 0, minimumSequence: 1, changes: [], projection: new Map(), coalesceIndex: new Map() };
      streams.set(key, stream);
    }
    const committedAt = input.committedAt ?? now();
    const resourceKey = deltaResourceKey(input.delta);
    const window = input.coalesceWindowMilliseconds ?? 1_000;
    if (input.delta.kind === "CURRENT_POSITION") {
      const bucket = `${resourceKey}:${Math.floor(committedAt.getTime() / window)}`;
      const sequence = stream.coalesceIndex.get(bucket);
      if (sequence !== undefined) {
        const index = stream.changes.findIndex((change) => change.sequence === sequence);
        const existing = stream.changes[index];
        if (existing) stream.changes[index] = Object.freeze({ ...existing, committedAt: committedAt.toISOString(), delta: Object.freeze({ ...input.delta }) });
        stream.projection.set(resourceKey, Object.freeze({ ...input.delta }));
        consumedEvents.add(eventKey);
        coalescedSamples += 1;
        return "COALESCED";
      }
      stream.coalesceIndex.set(bucket, stream.sequence + 1);
    }
    stream.sequence += 1;
    const change: RealtimeChange = Object.freeze({ streamId: stream.id, epoch: stream.epoch, sequence: stream.sequence,
      schemaVersion: REALTIME_SCHEMA_VERSION, committedAt: committedAt.toISOString(), delta: Object.freeze({ ...input.delta }) });
    stream.changes.push(change);
    stream.projection.set(resourceKey, change.delta);
    consumedEvents.add(eventKey);
    return "APPLIED";
  }

  async function snapshot(authorization: AuthorizedSubscription): Promise<SnapshotResult> {
    const selected = matchingStreams(authorization, true);
    const vectors = selected.map((stream) => ({ streamId: stream.id, epoch: stream.epoch, sequence: stream.sequence }));
    const projection = Object.fromEntries(selected.flatMap((stream) => [...stream.projection.entries()]));
    const digest = createHash("sha256").update(JSON.stringify(Object.entries(projection).sort(([left], [right]) => left.localeCompare(right)))).digest("base64url");
    return Object.freeze({ projection: Object.freeze(projection), etag: `"rt1.${digest}"`, cursor: issue(authorization, vectors) });
  }

  async function replay(authorization: AuthorizedSubscription, cursor: string, requestedLimit = REALTIME_LIMITS.maximumChangesPerBatch): Promise<ChangeQueryResponse> {
    let claims;
    try { claims = codec.decode(cursor, bindingFor(authorization)); }
    catch (error) {
      if (error instanceof CursorRejected) return Object.freeze({ outcome: "RESET_REQUIRED" as const, changes: [] as RealtimeChange[] });
      throw error;
    }
    const selected = matchingStreams(authorization, true);
    const byId = new Map(selected.map((stream) => [stream.id, stream]));
    if (claims.vectors.length !== selected.length || claims.vectors.some((vector) => !byId.has(vector.streamId))) return Object.freeze({ outcome: "RESET_REQUIRED" as const, changes: [] as RealtimeChange[] });
    for (const vector of claims.vectors) {
      const stream = byId.get(vector.streamId);
      if (!stream || vector.epoch !== stream.epoch || vector.sequence < stream.minimumSequence - 1 || vector.sequence > stream.sequence) return Object.freeze({ outcome: "RESET_REQUIRED" as const, changes: [] as RealtimeChange[] });
    }
    const limit = Math.min(Math.max(1, requestedLimit), REALTIME_LIMITS.maximumChangesPerBatch);
    const vectorByStream = new Map(claims.vectors.map((vector) => [vector.streamId, vector]));
    const candidates = selected.flatMap((stream) => stream.changes.filter((change) => change.sequence > (vectorByStream.get(stream.id)?.sequence ?? -1)))
      .sort((left, right) => left.committedAt.localeCompare(right.committedAt) || left.streamId.localeCompare(right.streamId) || left.sequence - right.sequence);
    const output: RealtimeChange[] = [];
    let bytes = 0;
    for (const change of candidates.slice(0, limit)) {
      assertDeltaAuthorized(authorization, change.delta.kind);
      const nextBytes = Buffer.byteLength(JSON.stringify(change));
      if (bytes + nextBytes > REALTIME_LIMITS.maximumOutboundBatchBytes) break;
      output.push(change);
      bytes += nextBytes;
    }
    const nextVectors = claims.vectors.map((vector) => {
      const applied = output.filter((change) => change.streamId === vector.streamId).at(-1);
      return applied ? { streamId: vector.streamId, epoch: vector.epoch, sequence: applied.sequence } : vector;
    });
    return Object.freeze({ outcome: "REPLAY" as const, cursor: issue(authorization, nextVectors), changes: output });
  }

  return Object.freeze({ append, snapshot, replay,
    compactBefore(streamId: string, minimumSequence: number) { const stream = [...streams.values()].find((candidate) => candidate.id === streamId); if (!stream) throw new Error("STREAM_NOT_FOUND"); stream.minimumSequence = minimumSequence; },
    changeCount() { return [...streams.values()].reduce((total, stream) => total + stream.changes.length, 0); },
    streamCount() { return streams.size; },
    coalescedCount() { return coalescedSamples; },
    vector(authorization: AuthorizedSubscription) { return matchingStreams(authorization, true).map((stream) => ({ streamId: stream.id, epoch: stream.epoch, sequence: stream.sequence })); },
  });
}

export function locationShard(driverReference: string, shardCount: number): number {
  if (!Number.isInteger(shardCount) || shardCount < 1 || shardCount > 256 || (shardCount & (shardCount - 1)) !== 0) throw new Error("LOCATION_SHARD_COUNT_INVALID");
  return createHash("sha256").update(driverReference).digest().readUInt32BE(0) % shardCount;
}

export function positionFreshness(capturedAt: string, observedAt: Date): "FRESH" | "DELAYED" | "STALE" {
  const age = observedAt.getTime() - Date.parse(capturedAt);
  if (!Number.isFinite(age) || age < 0) return "STALE";
  if (age >= 60_000) return "STALE";
  return age <= 15_000 ? "FRESH" : "DELAYED";
}
