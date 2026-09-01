import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient, Notification } from "pg";
import { Value } from "typebox/value";
import { validateEventEnvelope, validateThinJobPayload, type ThinJobPayload } from "@kavaroutes/durable-execution";
import type { AuthorizedSubscription } from "./authorization.js";
import { assertDeltaAuthorized } from "./authorization.js";
import { REALTIME_LIMITS, REALTIME_SCHEMA_VERSION, RealtimeDeltaSchema, type ChangeQueryResponse, type NormalizedScope, type RealtimeChange, type RealtimeDelta, type SubscriptionPurpose } from "./contracts.js";
import type { CursorBinding, CursorVector, TestOnlyCursorCodec } from "./cursor.js";
import { CursorRejected } from "./cursor.js";
import { REALTIME_NOTIFICATION_CHANNEL, type RealtimeWakeSource } from "./fanout.js";
import type { RealtimeAppend, RealtimeStore, SnapshotResult } from "./store.js";

export interface RealtimeProjectionDecision extends Omit<RealtimeAppend, "organizationId" | "sourceEventId"> {}

type ProjectionOutcome = "APPLIED" | "DUPLICATE" | "COALESCED";
type DatabaseRow = Record<string, unknown>;

const allowedDeltaKinds: Readonly<Record<SubscriptionPurpose, ReadonlySet<string>>> = Object.freeze({
  DISPATCH_CONTROL: new Set(["RESOURCE_INVALIDATED", "DISPATCH_CONTROL"]), DRIVER_MANIFEST: new Set(["RESOURCE_INVALIDATED", "DRIVER_MANIFEST"]),
  FACILITY_COORDINATION: new Set(["RESOURCE_INVALIDATED", "FACILITY_COORDINATION"]), OPERATION_PROGRESS: new Set(["RESOURCE_INVALIDATED", "OPERATION_PROGRESS"]),
  DISPATCH_CURRENT_POSITION: new Set(["CURRENT_POSITION"]),
});

const allowedSourcePurposes: Readonly<Record<SubscriptionPurpose, ReadonlySet<string>>> = Object.freeze({
  DISPATCH_CONTROL: new Set(["RIDER_INTAKE", "ASSIGNED_SERVICE_DELIVERY"]), DRIVER_MANIFEST: new Set(["ASSIGNED_SERVICE_DELIVERY"]),
  FACILITY_COORDINATION: new Set(["FACILITY_COORDINATION"]), OPERATION_PROGRESS: new Set(["ASSIGNED_SERVICE_DELIVERY", "PARTNER_EXPORT"]),
  DISPATCH_CURRENT_POSITION: new Set(["ASSIGNED_SERVICE_DELIVERY"]),
});

function validateProjectionDecision(decision: RealtimeProjectionDecision): void {
  if (!Value.Check(RealtimeDeltaSchema, decision.delta)) throw new Error("REALTIME_DELTA_SCHEMA_INVALID");
  if (!allowedDeltaKinds[decision.purpose].has(decision.delta.kind)) throw new Error("REALTIME_PROJECTION_POLICY_DENIED");
}

function validateSourceMessage(message: DatabaseRow | undefined): DatabaseRow {
  if (!message) throw new Error("REALTIME_SOURCE_MESSAGE_NOT_FOUND");
  validateEventEnvelope({ eventId: message.event_id, aggregateType: message.aggregate_type, aggregateId: message.aggregate_id,
    aggregateVersion: Number(message.aggregate_version), eventType: message.event_type, schemaVersion: message.schema_version,
    occurredAt: new Date(message.occurred_at as string | number | Date).toISOString(), commandId: message.command_id,
    idempotencyReferenceHash: message.idempotency_reference_hash, correlationId: message.correlation_id,
    ...(message.causation_id ? { causationId: message.causation_id } : {}), source: message.source,
    classificationReference: message.classification_reference, purposeReference: message.purpose_reference,
    policyReference: message.policy_reference, payload: message.payload });
  return message;
}

function assertSourcePurpose(decision: RealtimeProjectionDecision, message: DatabaseRow): void {
  if (!allowedSourcePurposes[decision.purpose].has(message.purpose_reference as string)) throw new Error("REALTIME_SOURCE_PURPOSE_DENIED");
}

function sourceAggregateType(message: DatabaseRow): string {
  return String(message.aggregate_type).toLowerCase().replaceAll("_", "-");
}

function scopeHash(scope: NormalizedScope): Buffer {
  const entries = Object.entries(scope).filter(([key]) => key !== "shard").sort(([left], [right]) => left.localeCompare(right));
  return createHash("sha256").update(JSON.stringify(Object.fromEntries(entries))).digest();
}

function resource(delta: RealtimeDelta): { kind: string; reference: string; version: number } {
  if (delta.kind === "CURRENT_POSITION") return { kind: "current-position", reference: delta.driverReference, version: delta.resourceVersion };
  if (delta.kind === "DRIVER_MANIFEST") return { kind: "manifest", reference: delta.manifestReference, version: delta.resourceVersion };
  if (delta.kind === "OPERATION_PROGRESS") return { kind: "operation", reference: delta.operationReference, version: delta.resourceVersion };
  if ("resourceReference" in delta) return { kind: delta.resourceKind, reference: delta.resourceReference, version: delta.resourceVersion };
  return { kind: "trip", reference: delta.tripReference, version: delta.resourceVersion };
}

function binding(authorization: AuthorizedSubscription): CursorBinding {
  return { organizationId: authorization.organizationId, principalId: authorization.principalId,
    authorizationGeneration: authorization.authorizationGeneration, purpose: authorization.purpose, scope: authorization.scope };
}

async function begin(client: PoolClient, role: "kavaroutes_outbox_consumer" | "kavaroutes_realtime", tenantId: string): Promise<void> {
  await client.query("BEGIN");
  await client.query(`SET LOCAL ROLE ${role}`);
  await client.query("SELECT set_config('app.tenant_id',$1,true)", [tenantId]);
}

async function beginRead(client: PoolClient, tenantId: string): Promise<void> {
  await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  await client.query("SET LOCAL ROLE kavaroutes_realtime");
  await client.query("SELECT set_config('app.tenant_id',$1,true)", [tenantId]);
}

async function rollback(client: PoolClient): Promise<void> { try { await client.query("ROLLBACK"); } catch { /* original failure wins */ } }

export function createPostgresRealtimeStore(pool: Pool, codec: TestOnlyCursorCodec, options: { readonly now?: () => Date; readonly idFactory?: () => string; readonly notify?: () => Promise<void> } = {}) {
  const now = options.now ?? (() => new Date());
  const idFactory = options.idFactory ?? randomUUID;
  const notify = options.notify ?? (async () => { await pool.query("SELECT pg_notify($1,'')", [REALTIME_NOTIFICATION_CHANNEL]); });

  function issue(authorization: AuthorizedSubscription, vectors: readonly CursorVector[]): string {
    return codec.encode({ organizationId: authorization.organizationId, principalId: authorization.principalId,
      authorizationGeneration: authorization.authorizationGeneration, purpose: authorization.purpose, scope: authorization.scope, vectors,
      lifetimeMilliseconds: authorization.scope.streamKind === "CURRENT_POSITION" ? REALTIME_LIMITS.locationReplayMilliseconds : REALTIME_LIMITS.materialReplayMilliseconds });
  }

  async function loadSourceMessage(client: PoolClient, payload: ThinJobPayload): Promise<DatabaseRow> {
    const source = await client.query(`SELECT m.event_id,m.aggregate_type,m.aggregate_id,m.aggregate_version,m.event_type,m.schema_version,
      m.occurred_at,m.command_id,m.idempotency_reference_hash,m.correlation_id,m.causation_id,m.source,m.classification_reference,
      m.purpose_reference,m.policy_reference,m.payload
      FROM outbox.delivery d JOIN outbox.message m ON m.tenant_id=d.tenant_id AND m.id=d.message_id
      WHERE d.tenant_id=$1 AND d.id=$2 AND d.route='realtime-signal' AND m.event_id=$3 FOR UPDATE OF d`,
    [payload.tenantId, payload.deliveryId, payload.eventId]);
    return validateSourceMessage(source.rows[0]);
  }

  async function assertSourceSequence(client: PoolClient, payload: ThinJobPayload, message: DatabaseRow): Promise<void> {
    const prior = await client.query(`SELECT COALESCE(max(source_aggregate_version),0)::bigint AS version FROM realtime.consumer_checkpoint
      WHERE tenant_id=$1 AND consumer_name='realtime.v1' AND source_aggregate_type=$2 AND source_aggregate_id=$3`,
    [payload.tenantId, sourceAggregateType(message), message.aggregate_id]);
    const expected = Number(prior.rows[0].version) + 1;
    if (Number(message.aggregate_version) !== expected) throw new Error(`REALTIME_SOURCE_VERSION_GAP:${expected}:${Number(message.aggregate_version)}`);
  }

  async function ensureStream(client: PoolClient, payload: ThinJobPayload, decision: RealtimeProjectionDecision): Promise<DatabaseRow> {
    const hash = scopeHash(decision.scope);
    const shard = decision.scope.shard ?? 0;
    await client.query(`INSERT INTO realtime.stream (tenant_id,id,purpose,scope_kind,scope_hash,shard)
      VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (tenant_id,purpose,scope_kind,scope_hash,shard) DO NOTHING`,
    [payload.tenantId, idFactory(), decision.purpose, decision.scope.streamKind, hash, shard]);
    const selected = await client.query(`SELECT id,epoch,last_sequence FROM realtime.stream
      WHERE tenant_id=$1 AND purpose=$2 AND scope_kind=$3 AND scope_hash=$4 AND shard=$5 AND lifecycle='ACTIVE' FOR UPDATE`,
    [payload.tenantId, decision.purpose, decision.scope.streamKind, hash, shard]);
    const stream = selected.rows[0];
    if (!stream) throw new Error("REALTIME_STREAM_NOT_ACTIVE");
    return stream;
  }

  async function persistChange(client: PoolClient, payload: ThinJobPayload, decision: RealtimeProjectionDecision, stream: DatabaseRow) {
    const target = resource(decision.delta);
    const committedAt = decision.committedAt ?? now();
    const coalesceWindow = decision.coalesceWindowMilliseconds ?? 1_000;
    const bucket = decision.delta.kind === "CURRENT_POSITION" ? Math.floor(committedAt.getTime() / coalesceWindow) : null;
    const existing = bucket === null ? null : (await client.query(`SELECT sequence_number FROM realtime.change
      WHERE tenant_id=$1 AND stream_id=$2 AND coalesce_reference=$3 AND coalesce_bucket=$4 FOR UPDATE`,
    [payload.tenantId, stream.id, target.reference, bucket])).rows[0];
    if (existing) {
      const sequence = Number(existing.sequence_number);
      await client.query(`UPDATE realtime.change SET source_event_id=$1,resource_version=$2,payload=$3,committed_at=$4,
        expires_at=$4::timestamptz+interval '15 minutes' WHERE tenant_id=$5 AND stream_id=$6 AND epoch=$7 AND sequence_number=$8`,
      [payload.eventId, target.version, decision.delta, committedAt, payload.tenantId, stream.id, Number(stream.epoch), sequence]);
      return { outcome: "COALESCED" as const, sequence, target };
    }
    const allocated = await client.query("UPDATE realtime.stream SET last_sequence=last_sequence+1,updated_at=now() WHERE tenant_id=$1 AND id=$2 RETURNING epoch,last_sequence", [payload.tenantId, stream.id]);
    const sequence = Number(allocated.rows[0].last_sequence);
    const expiresAt = new Date(committedAt.getTime() + (decision.delta.kind === "CURRENT_POSITION" ? REALTIME_LIMITS.locationReplayMilliseconds : REALTIME_LIMITS.materialReplayMilliseconds));
    await client.query(`INSERT INTO realtime.change
      (tenant_id,stream_id,epoch,sequence_number,source_event_id,delta_kind,resource_kind,resource_reference,resource_version,payload,coalesce_reference,coalesce_bucket,committed_at,expires_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
    [payload.tenantId, stream.id, Number(allocated.rows[0].epoch), sequence, payload.eventId, decision.delta.kind,
      target.kind, target.reference, target.version, decision.delta, bucket === null ? null : target.reference, bucket, committedAt, expiresAt]);
    return { outcome: "APPLIED" as const, sequence, target };
  }

  async function persistProjectionAndCheckpoint(client: PoolClient, payload: ThinJobPayload, decision: RealtimeProjectionDecision,
    message: DatabaseRow, stream: DatabaseRow, change: Awaited<ReturnType<typeof persistChange>>): Promise<void> {
    await client.query(`INSERT INTO realtime.projection
      (tenant_id,stream_id,resource_kind,resource_reference,resource_version,payload)
      VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (tenant_id,stream_id,resource_kind,resource_reference)
      DO UPDATE SET resource_version=EXCLUDED.resource_version,payload=EXCLUDED.payload,updated_at=now()
      WHERE realtime.projection.resource_version <= EXCLUDED.resource_version`,
    [payload.tenantId, stream.id, change.target.kind, change.target.reference, change.target.version, decision.delta]);
    await client.query(`INSERT INTO realtime.consumer_checkpoint
      (tenant_id,consumer_name,source_event_id,source_aggregate_type,source_aggregate_id,source_aggregate_version,stream_id,stream_epoch,stream_sequence,outcome,retain_until)
      VALUES ($1,'realtime.v1',$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [payload.tenantId, payload.eventId, sourceAggregateType(message), message.aggregate_id,
      Number(message.aggregate_version), stream.id, Number(stream.epoch), change.sequence, change.outcome, new Date(now().getTime() + 30 * 24 * 60 * 60 * 1000)]);
  }

  async function consume(unsafePayload: unknown, decision: RealtimeProjectionDecision, control: { readonly failBeforeCommit?: boolean; readonly failAfterCommit?: boolean } = {}): Promise<ProjectionOutcome> {
    const payload: ThinJobPayload = validateThinJobPayload(unsafePayload);
    if (payload.route !== "realtime-signal") throw new Error("REALTIME_ROUTE_REQUIRED");
    validateProjectionDecision(decision);
    const client = await pool.connect();
    let outcome: ProjectionOutcome = "APPLIED";
    try {
      await begin(client, "kavaroutes_outbox_consumer", payload.tenantId);
      const message = await loadSourceMessage(client, payload);
      assertSourcePurpose(decision, message);
      const duplicate = await client.query("SELECT outcome FROM realtime.consumer_checkpoint WHERE tenant_id=$1 AND consumer_name='realtime.v1' AND source_event_id=$2", [payload.tenantId, payload.eventId]);
      if (duplicate.rowCount) {
        await client.query("COMMIT");
        return "DUPLICATE";
      }
      await assertSourceSequence(client, payload, message);
      const stream = await ensureStream(client, payload, decision);
      const change = await persistChange(client, payload, decision, stream);
      outcome = change.outcome;
      await persistProjectionAndCheckpoint(client, payload, decision, message, stream, change);
      if (control.failBeforeCommit) throw new Error("SYNTHETIC_REALTIME_BEFORE_COMMIT");
      await client.query("COMMIT");
    } catch (error) { await rollback(client); throw error; }
    finally { client.release(); }
    await notify();
    if (control.failAfterCommit) throw new Error("SYNTHETIC_REALTIME_AFTER_COMMIT");
    return outcome;
  }

  async function selectStreams(client: PoolClient, authorization: AuthorizedSubscription) {
    return client.query(`SELECT id,epoch,last_sequence,minimum_sequence FROM realtime.stream
      WHERE tenant_id=$1 AND purpose=$2 AND scope_kind=$3 AND scope_hash=$4
        AND ($5::smallint IS NULL OR shard=$5) AND lifecycle='ACTIVE' ORDER BY id`,
    [authorization.organizationId, authorization.purpose, authorization.scope.streamKind, scopeHash(authorization.scope), authorization.scope.shard ?? null]);
  }

  async function snapshot(authorization: AuthorizedSubscription): Promise<SnapshotResult> {
    const client = await pool.connect();
    try {
      await beginRead(client, authorization.organizationId);
      const streams = await selectStreams(client, authorization);
      const vectors: CursorVector[] = streams.rows.map((row) => ({ streamId: row.id, epoch: Number(row.epoch), sequence: Number(row.last_sequence) }));
      const ids = streams.rows.map((row) => row.id);
      const projections = ids.length === 0 ? { rows: [] } : await client.query(`SELECT resource_kind,resource_reference,payload FROM realtime.projection
        WHERE tenant_id=$1 AND stream_id=ANY($2::uuid[]) ORDER BY stream_id,resource_kind,resource_reference`, [authorization.organizationId, ids]);
      const projection = Object.fromEntries(projections.rows.map((row) => [`${row.resource_kind}:${row.resource_reference}`, row.payload]));
      const digest = createHash("sha256").update(JSON.stringify(projection)).digest("base64url");
      const cursor = issue(authorization, vectors);
      await client.query("COMMIT");
      return Object.freeze({ projection: Object.freeze(projection), etag: `"rt1.${digest}"`, cursor });
    } catch (error) { await rollback(client); throw error; }
    finally { client.release(); }
  }

  async function replay(authorization: AuthorizedSubscription, cursor: string, requestedLimit = REALTIME_LIMITS.maximumChangesPerBatch): Promise<ChangeQueryResponse> {
    let claims;
    try { claims = codec.decode(cursor, binding(authorization)); }
    catch (error) { if (error instanceof CursorRejected) return Object.freeze({ outcome: "RESET_REQUIRED" as const, changes: [] as RealtimeChange[] }); throw error; }
    const client = await pool.connect();
    try {
      await beginRead(client, authorization.organizationId);
      const streams = await selectStreams(client, authorization);
      const byId = new Map(streams.rows.map((row) => [row.id as string, row]));
      if (claims.vectors.length !== streams.rowCount || claims.vectors.some((vector) => {
        const stream = byId.get(vector.streamId);
        return !stream || vector.epoch !== Number(stream.epoch) || vector.sequence < Number(stream.minimum_sequence) - 1 || vector.sequence > Number(stream.last_sequence);
      })) { await client.query("COMMIT"); return Object.freeze({ outcome: "RESET_REQUIRED" as const, changes: [] as RealtimeChange[] }); }
      const ids = claims.vectors.map((vector) => vector.streamId);
      const rows = ids.length === 0 ? { rows: [] } : await client.query(`SELECT stream_id,epoch,sequence_number,committed_at,payload FROM realtime.change
        WHERE tenant_id=$1 AND stream_id=ANY($2::uuid[]) AND compacted_at IS NULL ORDER BY committed_at,stream_id,sequence_number`,
      [authorization.organizationId, ids]);
      const high = new Map(claims.vectors.map((vector) => [vector.streamId, vector.sequence]));
      const limit = Math.min(Math.max(1, requestedLimit), REALTIME_LIMITS.maximumChangesPerBatch);
      const changes: RealtimeChange[] = [];
      let bytes = 0;
      for (const row of rows.rows) {
        if (Number(row.sequence_number) <= (high.get(row.stream_id) ?? -1)) continue;
        assertDeltaAuthorized(authorization, row.payload.kind);
        const change: RealtimeChange = { streamId: row.stream_id, epoch: Number(row.epoch), sequence: Number(row.sequence_number),
          schemaVersion: REALTIME_SCHEMA_VERSION, committedAt: new Date(row.committed_at).toISOString(), delta: row.payload };
        const size = Buffer.byteLength(JSON.stringify(change));
        if (changes.length >= limit || bytes + size > REALTIME_LIMITS.maximumOutboundBatchBytes) break;
        changes.push(Object.freeze(change)); bytes += size;
      }
      const nextVectors = claims.vectors.map((vector) => {
        const applied = changes.filter((change) => change.streamId === vector.streamId).at(-1);
        return applied ? { ...vector, sequence: applied.sequence } : vector;
      });
      await client.query("COMMIT");
      return Object.freeze({ outcome: "REPLAY" as const, cursor: issue(authorization, nextVectors), changes });
    } catch (error) { await rollback(client); throw error; }
    finally { client.release(); }
  }

  return Object.freeze({ consume, snapshot, replay } satisfies RealtimeStore & { consume: typeof consume });
}

export function createPostgresWakeSource(pool: Pool): RealtimeWakeSource {
  let listener: PoolClient | null = null;
  let handler: ((notification: Notification) => void) | null = null;
  return Object.freeze({
    async start(onWake: (payload: string) => void) {
      if (listener) throw new Error("REALTIME_LISTENER_ALREADY_STARTED");
      listener = await pool.connect();
      handler = (notification) => { if (notification.channel === REALTIME_NOTIFICATION_CHANNEL) onWake(notification.payload ?? ""); };
      listener.on("notification", handler);
      await listener.query(`LISTEN ${REALTIME_NOTIFICATION_CHANNEL}`);
    },
    async stop() {
      if (!listener) return;
      await listener.query(`UNLISTEN ${REALTIME_NOTIFICATION_CHANNEL}`);
      if (handler) listener.off("notification", handler);
      listener.release(); listener = null; handler = null;
    },
    async queueUsage() { const result = await pool.query("SELECT pg_notification_queue_usage() AS usage"); return Number(result.rows[0].usage); },
  });
}
