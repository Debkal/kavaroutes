import { randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import type { Pool, PoolClient } from "pg";
import { auditEvents, idempotencyRecords, organizations, runs } from "./schema.js";

export type RuntimeRole = "kavaroutes_api" | "kavaroutes_worker" | "kavaroutes_import" | "kavaroutes_outbox_publisher" | "kavaroutes_outbox_consumer" | "kavaroutes_realtime" | "kavaroutes_push_worker";

export class PersistenceConflict extends Error {
  readonly kind: "stale-version" | "duplicate" | "resource-overlap" | "relationship" | "tenant" | "idempotency-mismatch" | "idempotency-in-progress" | "idempotency-expired";
  constructor(kind: PersistenceConflict["kind"], message: string) {
    super(message);
    this.name = "PersistenceConflict";
    this.kind = kind;
  }
}

type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | { readonly [key: string]: JsonValue } | readonly JsonValue[];

export interface StoredMutationResult<T> {
  readonly replayed: boolean;
  readonly statusCode: number;
  readonly body: T;
  readonly headers: Readonly<Record<string, string>>;
}

export interface TenantMutationTransaction {
  readTrip(tripId: string): Promise<{ tripId: string; riderId: string; serviceDate: string; serviceTimezone: string; resolvedServiceAt: string; lifecycle: "DRAFT" | "CANCELLED"; version: number } | null>;
  createTripDraft(input: {
    tripId: string; riderId: string; serviceDate: string; serviceTimezone: string; localServiceTime: string;
    resolvedServiceAt: Date; resolvedUtcOffsetSeconds: number; ambiguityPolicy: "reject" | "earlier" | "later";
  }): Promise<{ tripId: string; riderId: string; serviceDate: string; serviceTimezone: string; resolvedServiceAt: string; lifecycle: "DRAFT"; version: number }>;
  updateTripLifecycle(input: { tripId: string; expectedVersion: number; lifecycleReference: "cancelled" }): Promise<{ tripId: string; riderId: string; serviceDate: string; serviceTimezone: string; resolvedServiceAt: string; lifecycle: "CANCELLED"; version: number }>;
  replaceDriverControlPolicy(input: {
    policyId: string; organizationId: string; expectedVersion: number; controls: JsonValue; locks: JsonValue;
    reasonCode: "OWNER_ENABLED_STRICT_PRESET" | "OPERATING_POLICY_CHANGED" | "EXTERNAL_REQUIREMENT_CHANGED"; actorId: string;
  }): Promise<{ policyId: string; version: number }>;
  appendAudit(input: { auditId: string; aggregateKind: string; aggregateId: string; aggregateVersion: number; actionReference: string; actorReference: string }): Promise<void>;
  appendOutboxMessage(input: {
    messageId: string; eventId: string; aggregateType: string; aggregateId: string; aggregateVersion: number;
    eventType: string; schemaVersion: string; occurredAt: Date; commandId: string; idempotencyReferenceHash: string;
    correlationId: string; causationId?: string; source: string; classificationReference: string; purposeReference: string;
    policyReference: string; payload: JsonValue; retainUntil: Date;
  }): Promise<void>;
  appendOutboxDelivery(input: { deliveryId: string; messageId: string; route: string; jobType: string; availableAt: Date; retainUntil: Date }): Promise<void>;
}

function rowToTrip(row: { id: string; rider_id: string; service_date: string | Date; service_timezone: string; resolved_service_at: Date; lifecycle_reference: string; aggregate_version: string }): {
  tripId: string; riderId: string; serviceDate: string; serviceTimezone: string; resolvedServiceAt: string; lifecycle: "DRAFT" | "CANCELLED"; version: number;
} {
  const serviceDate = row.service_date instanceof Date ? row.service_date.toISOString().slice(0, 10) : row.service_date;
  return {
    tripId: row.id, riderId: row.rider_id, serviceDate, serviceTimezone: row.service_timezone,
    resolvedServiceAt: row.resolved_service_at.toISOString(), lifecycle: row.lifecycle_reference === "cancelled" ? "CANCELLED" : "DRAFT",
    version: Number(row.aggregate_version),
  };
}

function transactionAdapter(client: PoolClient, tenantId: string): TenantMutationTransaction {
  return Object.freeze({
    async readTrip(tripId: string) {
      const result = await client.query(`SELECT id,rider_id,service_date,service_timezone,resolved_service_at,lifecycle_reference,aggregate_version
        FROM intake.trip_request WHERE tenant_id=$1 AND id=$2 FOR UPDATE`, [tenantId, tripId]);
      return result.rows[0] ? rowToTrip(result.rows[0]) : null;
    },
    async createTripDraft(input: Parameters<TenantMutationTransaction["createTripDraft"]>[0]) {
      const result = await client.query(`INSERT INTO intake.trip_request (
        tenant_id,id,rider_id,service_date,service_timezone,local_service_time,resolved_service_at,
        resolved_utc_offset_seconds,ambiguity_policy,ambiguity_policy_version,lifecycle_reference
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'civil-v1','draft')
      RETURNING id,rider_id,service_date,service_timezone,resolved_service_at,lifecycle_reference,aggregate_version`,
      [tenantId, input.tripId, input.riderId, input.serviceDate, input.serviceTimezone, input.localServiceTime,
        input.resolvedServiceAt, input.resolvedUtcOffsetSeconds, input.ambiguityPolicy]);
      const row = result.rows[0];
      if (!row) throw new Error("trip insert returned no row");
      return rowToTrip(row) as Awaited<ReturnType<TenantMutationTransaction["createTripDraft"]>>;
    },
    async updateTripLifecycle(input: Parameters<TenantMutationTransaction["updateTripLifecycle"]>[0]) {
      const result = await client.query(`UPDATE intake.trip_request SET lifecycle_reference=$1,
        aggregate_version=aggregate_version+1,updated_at=now()
        WHERE tenant_id=$2 AND id=$3 AND aggregate_version=$4
        RETURNING id,rider_id,service_date,service_timezone,resolved_service_at,lifecycle_reference,aggregate_version`,
      [input.lifecycleReference, tenantId, input.tripId, input.expectedVersion]);
      const row = result.rows[0];
      if (!row) throw new PersistenceConflict("stale-version", "trip version is stale");
      return rowToTrip(row) as Awaited<ReturnType<TenantMutationTransaction["updateTripLifecycle"]>>;
    },
    async replaceDriverControlPolicy(input: Parameters<TenantMutationTransaction["replaceDriverControlPolicy"]>[0]) {
      const current = await client.query<{ id: string; policy_version: string }>(`SELECT id,policy_version
        FROM platform.driver_control_policy WHERE tenant_id=$1 AND organization_id=$2 AND scope_kind='ORGANIZATION'
        AND scope_reference IS NULL AND lifecycle='ACTIVE' FOR UPDATE`, [tenantId, input.organizationId]);
      const active = current.rows[0];
      if (!active || Number(active.policy_version) !== input.expectedVersion) throw new PersistenceConflict("stale-version", "driver policy version is stale");
      const nextVersion = input.expectedVersion + 1;
      await client.query("UPDATE platform.driver_control_policy SET lifecycle='SUPERSEDED',aggregate_version=aggregate_version+1 WHERE tenant_id=$1 AND id=$2", [tenantId, active.id]);
      await client.query(`INSERT INTO platform.driver_control_policy (
        tenant_id,id,organization_id,scope_kind,scope_reference,policy_version,controls,locks,reason_code,created_by
      ) VALUES ($1,$2,$3,'ORGANIZATION',NULL,$4,$5::jsonb,$6::jsonb,$7,$8)`, [tenantId, input.policyId, input.organizationId,
        nextVersion, JSON.stringify(input.controls), JSON.stringify(input.locks), input.reasonCode, input.actorId]);
      return { policyId: input.policyId, version: nextVersion };
    },
    async appendAudit(input: Parameters<TenantMutationTransaction["appendAudit"]>[0]) {
      await client.query(`INSERT INTO audit.event (
        tenant_id,id,aggregate_kind,aggregate_id,aggregate_version,action_reference,actor_reference
      ) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [tenantId, input.auditId, input.aggregateKind, input.aggregateId,
        input.aggregateVersion, input.actionReference, input.actorReference]);
    },
    async appendOutboxMessage(input: Parameters<TenantMutationTransaction["appendOutboxMessage"]>[0]) {
      await client.query(`INSERT INTO outbox.message (
        tenant_id,id,event_id,aggregate_type,aggregate_id,aggregate_version,event_type,schema_version,occurred_at,
        command_id,idempotency_reference_hash,correlation_id,causation_id,source,classification_reference,
        purpose_reference,policy_reference,payload,retain_until
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18::jsonb,$19)`,
      [tenantId, input.messageId, input.eventId, input.aggregateType, input.aggregateId, input.aggregateVersion,
        input.eventType, input.schemaVersion, input.occurredAt, input.commandId, input.idempotencyReferenceHash,
        input.correlationId, input.causationId ?? null, input.source, input.classificationReference,
        input.purposeReference, input.policyReference, JSON.stringify(input.payload), input.retainUntil]);
    },
    async appendOutboxDelivery(input: Parameters<TenantMutationTransaction["appendOutboxDelivery"]>[0]) {
      await client.query(`INSERT INTO outbox.delivery (tenant_id,id,message_id,route,job_type,available_at,retain_until)
        VALUES ($1,$2,$3,$4,$5,$6,$7)`, [tenantId, input.deliveryId, input.messageId, input.route, input.jobType, input.availableAt, input.retainUntil]);
    },
  });
}

function mapDatabaseError(error: unknown): never {
  const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
  if (code === "23P01") throw new PersistenceConflict("resource-overlap", "resource reservation overlaps another run");
  if (code === "23505") throw new PersistenceConflict("duplicate", "tenant-scoped uniqueness conflict");
  if (code === "23503") throw new PersistenceConflict("relationship", "tenant-scoped relationship conflict");
  if (code === "42501") throw new PersistenceConflict("tenant", "tenant context denied");
  throw error;
}

export async function withTenantTransaction<T>(
  pool: Pool,
  tenantId: string,
  role: RuntimeRole,
  operation: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SET LOCAL ROLE ${role}`);
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    const result = await operation(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    mapDatabaseError(error);
  } finally {
    client.release();
  }
}

export function createPostgresPersistence(pool: Pool) {
  return {
    async createSyntheticOrganization(input: { tenantId: string; name: string; actor: string }) {
      return withTenantTransaction(pool, input.tenantId, "kavaroutes_api", async (client) => {
        const database = drizzle(client);
        const rows = await database.insert(organizations).values({
          tenantId: input.tenantId, id: input.tenantId, syntheticName: input.name,
        }).returning({ id: organizations.id, version: organizations.aggregateVersion });
        const created = rows[0];
        if (!created) throw new Error("organization insert returned no row");
        await database.insert(auditEvents).values({
          tenantId: input.tenantId, id: randomUUID(), aggregateKind: "organization", aggregateId: created.id,
          aggregateVersion: created.version, actionReference: "organization.created", actorReference: input.actor,
        });
        return created;
      });
    },

    async updateRunExpectedVersion(input: { tenantId: string; runId: string; expectedVersion: number; lifecycleReference: string; actor: string }) {
      return withTenantTransaction(pool, input.tenantId, "kavaroutes_api", async (client) => {
        const changed = await client.query<{ aggregate_version: string }>(`UPDATE dispatch.run
          SET lifecycle_reference = $1, aggregate_version = aggregate_version + 1, updated_at = now()
          WHERE tenant_id = $2 AND id = $3 AND aggregate_version = $4
          RETURNING aggregate_version`, [input.lifecycleReference, input.tenantId, input.runId, input.expectedVersion]);
        const row = changed.rows[0];
        if (!row) throw new PersistenceConflict("stale-version", "run version is stale");
        const nextVersion = Number(row.aggregate_version);
        await drizzle(client).insert(auditEvents).values({
          tenantId: input.tenantId, id: randomUUID(), aggregateKind: "run", aggregateId: input.runId,
          aggregateVersion: nextVersion, actionReference: "run.lifecycle-reference-changed", actorReference: input.actor,
        });
        return { version: nextVersion };
      });
    },

    async rememberIdempotentResult(input: { tenantId: string; id: string; operationKey: string; fingerprint: string; resultReference: string }) {
      return withTenantTransaction(pool, input.tenantId, "kavaroutes_api", async (client) => {
        const database = drizzle(client);
        const rows = await database.insert(idempotencyRecords).values({
          tenantId: input.tenantId, id: input.id, operationKey: input.operationKey,
          requestFingerprint: input.fingerprint, resultReference: input.resultReference, actorReference: "legacy-synthetic-actor",
          operationId: "legacy-operation", state: "COMMITTED", responseStatus: 200, responseBody: {}, responseHeaders: {},
          expiresAt: new Date(Date.now() + 86_400_000),
        }).onConflictDoNothing({ target: [idempotencyRecords.tenantId, idempotencyRecords.actorReference, idempotencyRecords.operationId, idempotencyRecords.operationKey] })
          .returning({ resultReference: idempotencyRecords.resultReference });
        if (rows[0]) return { replayed: false, resultReference: rows[0].resultReference };
        const existing = await client.query<{ request_fingerprint: string; result_reference: string }>(
          "SELECT request_fingerprint, result_reference FROM platform.idempotency_record WHERE tenant_id = $1 AND actor_reference='legacy-synthetic-actor' AND operation_id='legacy-operation' AND operation_key = $2",
          [input.tenantId, input.operationKey],
        );
        const result = existing.rows[0];
        if (!result || result.request_fingerprint !== input.fingerprint) {
          throw new PersistenceConflict("duplicate", "idempotency key was reused with a different fingerprint");
        }
        return { replayed: true, resultReference: result.result_reference };
      });
    },

    async executeIdempotentMutation<T>(input: {
      tenantId: string; actorReference: string; operationId: string; key: string; fingerprint: string;
      recordId: string; expiresAt: Date; failBeforeCommit?: boolean;
    }, effect: (transaction: TenantMutationTransaction) => Promise<{ statusCode: number; body: T; headers: Readonly<Record<string, string>>; resultReference: string }>): Promise<StoredMutationResult<T>> {
      return withTenantTransaction(pool, input.tenantId, "kavaroutes_api", async (client) => {
        const inserted = await client.query(`INSERT INTO platform.idempotency_record (
          tenant_id,id,operation_key,request_fingerprint,result_reference,actor_reference,operation_id,state,
          response_status,response_body,response_headers,expires_at
        ) VALUES ($1,$2,$3,$4,'pending',$5,$6,'IN_PROGRESS',500,'{}'::jsonb,'{}'::jsonb,$7)
        ON CONFLICT (tenant_id,actor_reference,operation_id,operation_key) DO NOTHING RETURNING id`,
        [input.tenantId, input.recordId, input.key, input.fingerprint, input.actorReference, input.operationId, input.expiresAt]);

        if (inserted.rowCount === 0) {
          const existing = await client.query(`SELECT request_fingerprint,state,response_status,response_body,response_headers,expires_at
            FROM platform.idempotency_record WHERE tenant_id=$1 AND actor_reference=$2 AND operation_id=$3 AND operation_key=$4`,
          [input.tenantId, input.actorReference, input.operationId, input.key]);
          const row = existing.rows[0];
          if (!row) throw new PersistenceConflict("duplicate", "idempotency conflict");
          if (row.request_fingerprint !== input.fingerprint) throw new PersistenceConflict("idempotency-mismatch", "idempotency fingerprint differs");
          if (new Date(row.expires_at) <= new Date()) throw new PersistenceConflict("idempotency-expired", "idempotency record expired");
          if (row.state !== "COMMITTED") throw new PersistenceConflict("idempotency-in-progress", "idempotency operation unresolved");
          return { replayed: true, statusCode: row.response_status, body: row.response_body as T, headers: row.response_headers as Record<string, string> };
        }

        const committed = await effect(transactionAdapter(client, input.tenantId));
        await client.query(`UPDATE platform.idempotency_record SET state='COMMITTED',result_reference=$1,
          response_status=$2,response_body=$3::jsonb,response_headers=$4::jsonb
          WHERE tenant_id=$5 AND id=$6`, [committed.resultReference, committed.statusCode, JSON.stringify(committed.body),
          JSON.stringify(committed.headers), input.tenantId, input.recordId]);
        if (input.failBeforeCommit) throw new Error("SYNTHETIC_FAILURE_BEFORE_COMMIT");
        return { replayed: false, statusCode: committed.statusCode, body: committed.body, headers: committed.headers };
      });
    },

    async readTrip(tenantId: string, tripId: string) {
      return withTenantTransaction(pool, tenantId, "kavaroutes_api", async (client) => {
        const result = await client.query(`SELECT id,rider_id,service_date,service_timezone,resolved_service_at,lifecycle_reference,aggregate_version
          FROM intake.trip_request WHERE tenant_id=$1 AND id=$2`, [tenantId, tripId]);
        return result.rows[0] ? rowToTrip(result.rows[0]) : null;
      });
    },

    async listTrips(tenantId: string, input: { afterId?: string; limit: number }) {
      return withTenantTransaction(pool, tenantId, "kavaroutes_api", async (client) => {
        const result = await client.query(`SELECT id,rider_id,service_date,service_timezone,resolved_service_at,lifecycle_reference,aggregate_version
          FROM intake.trip_request WHERE tenant_id=$1 AND ($2::uuid IS NULL OR id>$2::uuid) ORDER BY id LIMIT $3`,
        [tenantId, input.afterId ?? null, input.limit + 1]);
        return result.rows.map(rowToTrip);
      });
    },

    async searchSyntheticRiders(tenantId: string, prefix: string, limit: number) {
      return withTenantTransaction(pool, tenantId, "kavaroutes_api", async (client) => {
        const result = await client.query<{ id: string; synthetic_reference: string }>(`SELECT id,synthetic_reference FROM intake.rider
          WHERE tenant_id=$1 AND synthetic_reference LIKE $2 ESCAPE '\\' ORDER BY synthetic_reference,id LIMIT $3`,
        [tenantId, `${prefix.replaceAll("%", "\\%").replaceAll("_", "\\_")}%`, limit]);
        return result.rows.map((row) => ({ riderId: row.id, syntheticReference: row.synthetic_reference }));
      });
    },

    async readDispatchDay(tenantId: string, serviceDate: string) {
      return withTenantTransaction(pool, tenantId, "kavaroutes_api", async (client) => {
        const result = await client.query(`SELECT id,service_timezone,planned_start_at,planned_end_at,lifecycle_reference,aggregate_version
          FROM dispatch.run WHERE tenant_id=$1 AND service_date=$2 ORDER BY planned_start_at,id LIMIT 200`, [tenantId, serviceDate]);
        return result.rows.map((row) => ({ runId: row.id as string, serviceTimezone: row.service_timezone as string,
          plannedStartAt: (row.planned_start_at as Date).toISOString(), plannedEndAt: (row.planned_end_at as Date).toISOString(),
          lifecycle: String(row.lifecycle_reference).toUpperCase(), version: Number(row.aggregate_version) }));
      });
    },

    async advanceCurrentPosition(input: {
      tenantId: string; subjectKind: "driver" | "vehicle"; subjectId: string; deviceId: string;
      streamEpoch: number; sequenceNumber: number; capturedAt: Date; recordedAt: Date;
      longitude: number; latitude: number; sourceBatchId?: string;
    }) {
      return withTenantTransaction(pool, input.tenantId, "kavaroutes_worker", async (client) => {
        const result = await client.query<{ advanced: boolean }>(`SELECT realtime.advance_current_position(
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11
        ) AS advanced`, [input.tenantId, input.subjectKind, input.subjectId, input.deviceId, input.streamEpoch,
          input.sequenceNumber, input.capturedAt, input.recordedAt, input.longitude, input.latitude,
          input.sourceBatchId ?? null]);
        return result.rows[0]?.advanced ?? false;
      });
    },

    tables: { organizations, runs },
  };
}

export function createPushPersistence(pool: Pool) {
  return Object.freeze({
    async upsertRegistration(input: {
      tenantId: string; id: string; organizationId: string; principalId: string; subjectId: string; installationId: string;
      generation: string; platform: "ios" | "android"; provider: "apns" | "fcm"; environment: "sandbox" | "development";
      appId: string; tokenCiphertext: Uint8Array; tokenKeyedHash: Uint8Array; permission: string; channelEnabled: boolean;
    }) {
      return withTenantTransaction(pool, input.tenantId, "kavaroutes_api", async (client) => {
        await client.query(`UPDATE notification.installation_registration SET lifecycle='INACTIVE',inactive_reason='installation_replaced',invalidated_at=now(),refreshed_at=now()
          WHERE tenant_id=$1 AND installation_id=$2 AND installation_generation<>$3 AND lifecycle='ACTIVE'`, [input.tenantId, input.installationId, input.generation]);
        const result = await client.query(`INSERT INTO notification.installation_registration
          (tenant_id,id,organization_id,principal_id,subject_id,installation_id,installation_generation,platform,provider,provider_environment,app_identity,token_ciphertext,token_keyed_hash,permission_state,channel_enabled)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
          ON CONFLICT (tenant_id,installation_id,installation_generation) DO UPDATE SET
          token_ciphertext=excluded.token_ciphertext,token_keyed_hash=excluded.token_keyed_hash,permission_state=excluded.permission_state,
          channel_enabled=excluded.channel_enabled,lifecycle='ACTIVE',inactive_reason=NULL,invalidated_at=NULL,refreshed_at=now(),last_confirmed_at=now()
          WHERE notification.installation_registration.organization_id=excluded.organization_id
            AND notification.installation_registration.principal_id=excluded.principal_id
            AND notification.installation_registration.subject_id=excluded.subject_id
          RETURNING id,lifecycle,last_confirmed_at`, [input.tenantId, input.id, input.organizationId, input.principalId, input.subjectId,
          input.installationId, input.generation, input.platform, input.provider, input.environment, input.appId,
          Buffer.from(input.tokenCiphertext), Buffer.from(input.tokenKeyedHash), input.permission, input.channelEnabled]);
        if (!result.rows[0]) throw new PersistenceConflict("relationship", "registration binding differs");
        return { id: result.rows[0].id as string, lifecycle: result.rows[0].lifecycle as string, lastConfirmedAt: (result.rows[0].last_confirmed_at as Date).toISOString() };
      });
    },
    async deactivateRegistration(input: { tenantId: string; organizationId: string; principalId: string; subjectId: string; installationId: string; generation: string; reason: string }) {
      return withTenantTransaction(pool, input.tenantId, "kavaroutes_api", async (client) => {
        const result = await client.query(`UPDATE notification.installation_registration SET lifecycle='INACTIVE',inactive_reason=$1,invalidated_at=now(),refreshed_at=now()
          WHERE tenant_id=$2 AND organization_id=$3 AND principal_id=$4 AND subject_id=$5 AND installation_id=$6 AND installation_generation=$7 AND lifecycle='ACTIVE'
          RETURNING id`, [input.reason, input.tenantId, input.organizationId, input.principalId, input.subjectId, input.installationId, input.generation]);
        if (!result.rows[0]) throw new PersistenceConflict("relationship", "registration hidden or inactive");
        return { id: result.rows[0].id as string };
      });
    },
    async activeRegistrationCount(tenantId: string, principalId: string) {
      return withTenantTransaction(pool, tenantId, "kavaroutes_push_worker", async (client) => {
        const result = await client.query<{ count: number }>("SELECT count(*)::int AS count FROM notification.installation_registration WHERE tenant_id=$1 AND principal_id=$2 AND lifecycle='ACTIVE'", [tenantId, principalId]);
        return result.rows[0]?.count ?? 0;
      });
    },
  });
}
