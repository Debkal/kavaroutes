import { bigint, date, integer, jsonb, pgSchema, primaryKey, text, time, timestamp, unique, uuid } from "drizzle-orm/pg-core";

export const platform = pgSchema("platform");
export const intake = pgSchema("intake");
export const fleet = pgSchema("fleet");
export const dispatch = pgSchema("dispatch");
export const execution = pgSchema("execution");
export const realtime = pgSchema("realtime");
export const billing = pgSchema("billing");
export const integration = pgSchema("integration");
export const audit = pgSchema("audit");

const version = () => bigint("aggregate_version", { mode: "number" }).notNull().default(1);
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

export const organizations = platform.table("organization", {
  tenantId: uuid("tenant_id").notNull(),
  id: uuid("id").notNull(),
  syntheticName: text("synthetic_name").notNull(),
  commercialTier: text("commercial_tier").notNull().default("ENTERPRISE"),
  aggregateVersion: version(),
  createdAt: createdAt(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [primaryKey({ columns: [table.tenantId, table.id] }), unique().on(table.tenantId)]);

export const branches = platform.table("branch", {
  tenantId: uuid("tenant_id").notNull(), id: uuid("id").notNull(), organizationId: uuid("organization_id").notNull(),
  syntheticLabel: text("synthetic_label").notNull(), aggregateVersion: version(), createdAt: createdAt(),
}, (table) => [primaryKey({ columns: [table.tenantId, table.id] })]);

export const idempotencyRecords = platform.table("idempotency_record", {
  tenantId: uuid("tenant_id").notNull(), id: uuid("id").notNull(), operationKey: text("operation_key").notNull(),
  requestFingerprint: text("request_fingerprint").notNull(), resultReference: text("result_reference").notNull(),
  actorReference: text("actor_reference").notNull(), operationId: text("operation_id").notNull(), state: text("state").notNull(),
  responseStatus: integer("response_status").notNull(), responseBody: jsonb("response_body").notNull(),
  responseHeaders: jsonb("response_headers").notNull(), createdAt: createdAt(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
}, (table) => [primaryKey({ columns: [table.tenantId, table.id] }), unique().on(table.tenantId, table.actorReference, table.operationId, table.operationKey)]);

export const addresses = intake.table("address", {
  tenantId: uuid("tenant_id").notNull(), id: uuid("id").notNull(), customerLabel: text("customer_label").notNull(),
  providerReference: text("provider_reference"), providerCacheExpiresAt: timestamp("provider_cache_expires_at", { withTimezone: true }),
  providerProvenance: text("provider_provenance"), createdAt: createdAt(),
}, (table) => [primaryKey({ columns: [table.tenantId, table.id] })]);

export const facilities = intake.table("facility", {
  tenantId: uuid("tenant_id").notNull(), id: uuid("id").notNull(), addressId: uuid("address_id").notNull(),
  syntheticLabel: text("synthetic_label").notNull(), aggregateVersion: version(), createdAt: createdAt(),
}, (table) => [primaryKey({ columns: [table.tenantId, table.id] })]);

export const riders = intake.table("rider", {
  tenantId: uuid("tenant_id").notNull(), id: uuid("id").notNull(), homeAddressId: uuid("home_address_id"),
  syntheticReference: text("synthetic_reference").notNull(), aggregateVersion: version(), createdAt: createdAt(),
}, (table) => [primaryKey({ columns: [table.tenantId, table.id] }), unique().on(table.tenantId, table.syntheticReference)]);

export const tripRequests = intake.table("trip_request", {
  tenantId: uuid("tenant_id").notNull(), id: uuid("id").notNull(), riderId: uuid("rider_id").notNull(),
  serviceDate: date("service_date").notNull(), serviceTimezone: text("service_timezone").notNull(),
  localServiceTime: time("local_service_time").notNull(), resolvedServiceAt: timestamp("resolved_service_at", { withTimezone: true }).notNull(),
  resolvedUtcOffsetSeconds: integer("resolved_utc_offset_seconds").notNull(), ambiguityPolicy: text("ambiguity_policy").notNull(),
  ambiguityPolicyVersion: text("ambiguity_policy_version").notNull(), aggregateVersion: version(),
  lifecycleReference: text("lifecycle_reference").notNull(), createdAt: createdAt(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [primaryKey({ columns: [table.tenantId, table.id] })]);

export const drivers = fleet.table("driver", {
  tenantId: uuid("tenant_id").notNull(), id: uuid("id").notNull(), syntheticReference: text("synthetic_reference").notNull(),
  workforceRelationship: text("workforce_relationship").notNull().default("EMPLOYEE"),
  aggregateVersion: version(), createdAt: createdAt(),
}, (table) => [primaryKey({ columns: [table.tenantId, table.id] })]);

export const vehicles = fleet.table("vehicle", {
  tenantId: uuid("tenant_id").notNull(), id: uuid("id").notNull(), syntheticReference: text("synthetic_reference").notNull(),
  aggregateVersion: version(), createdAt: createdAt(),
}, (table) => [primaryKey({ columns: [table.tenantId, table.id] })]);

export const runs = dispatch.table("run", {
  tenantId: uuid("tenant_id").notNull(), id: uuid("id").notNull(), branchId: uuid("branch_id").notNull(),
  serviceDate: date("service_date").notNull(), serviceTimezone: text("service_timezone").notNull(),
  plannedStartAt: timestamp("planned_start_at", { withTimezone: true }).notNull(),
  plannedEndAt: timestamp("planned_end_at", { withTimezone: true }).notNull(), lifecycleReference: text("lifecycle_reference").notNull(),
  aggregateVersion: version(), createdAt: createdAt(), updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [primaryKey({ columns: [table.tenantId, table.id] })]);

export const driverControlPolicies = platform.table("driver_control_policy", {
  tenantId: uuid("tenant_id").notNull(), id: uuid("id").notNull(), organizationId: uuid("organization_id").notNull(),
  scopeKind: text("scope_kind").notNull(), scopeReference: uuid("scope_reference"), policyVersion: bigint("policy_version", { mode: "number" }).notNull(),
  controls: jsonb("controls").notNull(), locks: jsonb("locks").notNull(), lifecycle: text("lifecycle").notNull().default("ACTIVE"),
  reasonCode: text("reason_code").notNull(), aggregateVersion: version(), createdAt: createdAt(), createdBy: uuid("created_by").notNull(),
}, (table) => [primaryKey({ columns: [table.tenantId, table.id] }), unique().on(table.tenantId, table.organizationId, table.scopeKind, table.scopeReference, table.policyVersion)]);

export const driverExternalFloorReferences = platform.table("driver_external_floor_reference", {
  tenantId: uuid("tenant_id").notNull(), id: uuid("id").notNull(), organizationId: uuid("organization_id").notNull(),
  floorKind: text("floor_kind").notNull(), safeReference: text("safe_reference").notNull(), controls: jsonb("controls").notNull(),
  policyVersion: bigint("policy_version", { mode: "number" }).notNull(), effectiveFrom: timestamp("effective_from", { withTimezone: true }).notNull(),
  effectiveUntil: timestamp("effective_until", { withTimezone: true }), createdAt: createdAt(),
}, (table) => [primaryKey({ columns: [table.tenantId, table.id] }), unique().on(table.tenantId, table.organizationId, table.floorKind, table.safeReference, table.policyVersion)]);

export const shiftPolicySnapshots = execution.table("shift_policy_snapshot", {
  tenantId: uuid("tenant_id").notNull(), id: uuid("id").notNull(), assignmentId: uuid("assignment_id").notNull(), driverId: uuid("driver_id").notNull(),
  shiftGeneration: uuid("shift_generation").notNull(), policyVersion: bigint("policy_version", { mode: "number" }).notNull(),
  policyDigest: text("policy_digest").notNull(), effectivePolicy: jsonb("effective_policy").notNull(), lifecycle: text("lifecycle").notNull().default("ACTIVE"),
  pinnedAt: timestamp("pinned_at", { withTimezone: true }).notNull().defaultNow(), invalidatedAt: timestamp("invalidated_at", { withTimezone: true }),
  invalidationReasonCode: text("invalidation_reason_code"),
}, (table) => [primaryKey({ columns: [table.tenantId, table.id] }), unique().on(table.tenantId, table.assignmentId, table.shiftGeneration)]);

export const auditEvents = audit.table("event", {
  tenantId: uuid("tenant_id").notNull(), id: uuid("id").notNull(), aggregateKind: text("aggregate_kind").notNull(),
  aggregateId: uuid("aggregate_id").notNull(), aggregateVersion: bigint("aggregate_version", { mode: "number" }).notNull(),
  actionReference: text("action_reference").notNull(), actorReference: text("actor_reference").notNull(),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(), metadata: jsonb("metadata").notNull().default({}),
}, (table) => [primaryKey({ columns: [table.tenantId, table.id] })]);

export const locationBatchReceipts = realtime.table("location_batch_receipt", {
  tenantId: uuid("tenant_id").notNull(), id: uuid("id").notNull(), deviceId: uuid("device_id").notNull(),
  requestFingerprint: text("request_fingerprint").notNull(), sampleCount: integer("sample_count").notNull(),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [primaryKey({ columns: [table.tenantId, table.id] }), unique().on(table.tenantId, table.deviceId, table.requestFingerprint)]);

export const billingCases = billing.table("billing_case", {
  tenantId: uuid("tenant_id").notNull(), id: uuid("id").notNull(), tripRequestId: uuid("trip_request_id").notNull(),
  lifecycleReference: text("lifecycle_reference").notNull(), aggregateVersion: version(), createdAt: createdAt(),
}, (table) => [primaryKey({ columns: [table.tenantId, table.id] })]);

export const integrationReceipts = integration.table("receipt", {
  tenantId: uuid("tenant_id").notNull(), id: uuid("id").notNull(), sourceReference: text("source_reference").notNull(),
  requestFingerprint: text("request_fingerprint").notNull(), receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [primaryKey({ columns: [table.tenantId, table.id] }), unique().on(table.tenantId, table.sourceReference)]);
