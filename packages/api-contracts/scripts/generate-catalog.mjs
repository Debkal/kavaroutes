import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("../../../", import.meta.url)));
const source = JSON.parse(await readFile(resolve(root, "contracts/nemt-domain/catalog/command-event-catalog.json"), "utf8"));
const machines = JSON.parse(await readFile(resolve(root, "contracts/nemt-domain/machines/state-machines.json"), "utf8"));
const explicitProhibitions = machines.machines.flatMap((machine) => machine.explicitProhibitions.map((entry) => ({
  machineId: machine.id,
  from: entry.from,
  commandId: entry.command,
  reason: entry.reason,
})));

const resourceFamilies = [
  { id: "profile", path: "/v1/me", audience: "authenticated", rule: "safe principal and membership projection" },
  { id: "riders", path: "/v1/organizations/{organizationId}/riders", audience: "dispatcher-intake", rule: "identity search uses bounded POST" },
  { id: "facilities", path: "/v1/organizations/{organizationId}/facilities", audience: "dispatcher-admin", rule: "facility users use relationship projection" },
  { id: "trips", path: "/v1/organizations/{organizationId}/trips", audience: "intake-dispatch-billing", rule: "purpose-specific projection" },
  { id: "authorizations", path: "/v1/organizations/{organizationId}/authorizations", audience: "intake-billing", rule: "versioned policy reference" },
  { id: "dispatch-days", path: "/v1/organizations/{organizationId}/dispatch-days/{serviceDate}", audience: "dispatcher", rule: "versioned civil-day snapshot" },
  { id: "runs", path: "/v1/organizations/{organizationId}/dispatch-days/{serviceDate}/runs", audience: "dispatcher", rule: "ordered manifest projection" },
  { id: "assignments", path: "/v1/organizations/{organizationId}/assignments", audience: "dispatcher-driver", rule: "relationship and version scoped" },
  { id: "fleet", path: "/v1/organizations/{organizationId}/fleet", audience: "fleet-dispatch", rule: "no rider projection" },
  { id: "driver", path: "/v1/organizations/{organizationId}/driver", audience: "assigned-driver", rule: "minimum necessary manifest/actions/locations" },
  { id: "facility", path: "/v1/organizations/{organizationId}/facility", audience: "facility-user", rule: "related trips only" },
  { id: "executions", path: "/v1/organizations/{organizationId}/executions", audience: "driver-dispatch-billing", rule: "purpose-specific execution/evidence" },
  { id: "billing", path: "/v1/organizations/{organizationId}/billing", audience: "billing", rule: "financial capability required" },
  { id: "invoices", path: "/v1/organizations/{organizationId}/billing/invoices", audience: "billing", rule: "append/adjust/void lineage" },
  { id: "claims", path: "/v1/organizations/{organizationId}/billing/claims", audience: "billing", rule: "claim history lineage" },
  { id: "imports", path: "/v1/organizations/{organizationId}/imports", audience: "integration", rule: "receipt reconciliation" },
  { id: "operations", path: "/v1/organizations/{organizationId}/operations/{operationId}", audience: "authorized-operation-owner", rule: "safe nonauthoritative progress" },
  { id: "recommendations", path: "/v1/organizations/{organizationId}/recommendations", audience: "dispatcher", rule: "advisory only and planned" },
  { id: "audit", path: "/v1/organizations/{organizationId}/audit-events", audience: "audit-compliance", rule: "material history, not logs" }
];

const aggregateConfig = {
  TRIP_REQUEST: { base: "/trips/{tripId}", parameter: "tripId", capability: "trips:command", purpose: "RIDER_INTAKE", relationship: "tenant-visible-trip", success: "TripCommandResponse" },
  RUN: { base: "/dispatch-days/{serviceDate}/runs/{runId}", parameter: "runId", capability: "dispatch:command", purpose: "ASSIGNED_SERVICE_DELIVERY", relationship: "branch-scoped-run", success: "RunCommandResponse" },
  ASSIGNMENT: { base: "/assignments/{assignmentId}", parameter: "assignmentId", capability: "dispatch:command", purpose: "ASSIGNED_SERVICE_DELIVERY", relationship: "branch-or-assigned-driver", success: "AssignmentCommandResponse" },
  LEG_EXECUTION: { base: "/executions/{executionId}", parameter: "executionId", capability: "driver:execute", purpose: "ASSIGNED_SERVICE_DELIVERY", relationship: "assigned-driver-or-dispatch", success: "ExecutionCommandResponse" },
  EVIDENCE_RECORD: { base: "/executions/{executionId}/evidence/{evidenceId}", parameter: "evidenceId", capability: "driver:execute", purpose: "ASSIGNED_SERVICE_DELIVERY", relationship: "execution-purpose", success: "EvidenceCommandResponse" },
  LOCATION_STREAM: { base: "/driver/location-batches", parameter: "deviceId", capability: "driver:location:write", purpose: "ASSIGNED_SERVICE_DELIVERY", relationship: "self-device", success: "BatchReceipt" },
  BILLING_CASE: { base: "/billing/cases/{billingCaseId}", parameter: "billingCaseId", capability: "billing:command", purpose: "BILLING_PROOF", relationship: "billing-capability", success: "BillingCommandResponse" },
  INVOICE_CLAIM: { base: "/billing/invoices/{invoiceId}", parameter: "invoiceId", capability: "billing:command", purpose: "BILLING_PROOF", relationship: "billing-capability", success: "FinancialCommandResponse" }
};

function slug(value) {
  return value.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
}
function operationId(value) { return value[0].toLowerCase() + value.slice(1); }

const commandMappings = source.commands.map((command) => {
  const config = { ...aggregateConfig[command.aggregate] };
  if (!config) throw new Error(`UNMAPPED_AGGREGATE:${command.aggregate}`);
  if (command.aggregate === "INVOICE_CLAIM" && command.area === "CLAIM") config.base = "/billing/claims/{claimId}";
  const isCreate = command.id === "CreateTripDraft";
  const isLocationBatch = command.id === "RecordLocationBatch";
  const path = isCreate ? "/v1/organizations/{organizationId}/trips"
    : isLocationBatch ? "/v1/organizations/{organizationId}/driver/location-batches"
      : command.id === "CancelTrip" ? "/v1/organizations/{organizationId}/trips/{tripId}/commands/cancel"
        : `/v1/organizations/{organizationId}${config.base}/commands/${slug(command.id)}`;
  const implementationState = command.event == null ? "PROHIBITED_BY_DOMAIN_CONTRACT"
    : ["CreateTripDraft", "CancelTrip", "RecordLocationBatch"].includes(command.id) ? "IMPLEMENTED_REPRESENTATIVE" : "PLANNED_NOT_REGISTERED";
  return {
    commandId: command.id,
    area: command.area,
    owningAggregate: command.aggregate,
    eventId: command.event,
    method: "POST",
    path,
    operationId: isCreate ? "createTrip" : isLocationBatch ? "submitDriverLocationBatch" : operationId(command.id),
    capability: config.capability,
    purpose: config.purpose,
    relationshipRule: config.relationship,
    requestSchema: `${command.id}Request`,
    successSchema: isCreate ? "DispatcherTrip" : config.success,
    problemSchemas: ["Problem:400", "Problem:401", "Problem:403", "Problem:404", "Problem:409", "Problem:412", "Problem:422", "Problem:428", "Problem:429", "Problem:500"],
    ifMatchRequired: !isCreate && !isLocationBatch,
    idempotencyRequired: true,
    disposition: ["MaterializeTrips", "AcceptOptimizationProposal"].includes(command.id) ? "ASYNC_OPERATION" : "SYNCHRONOUS_AFTER_COMMIT",
    implementationState
  };
});

const liveOperations = [
  ["getMe", "GET", "/v1/me", "profile:read", "SUPPORT_DIAGNOSTICS"],
  ["listTrips", "GET", "/v1/organizations/{organizationId}/trips", "trips:read", "RIDER_INTAKE"],
  ["searchRiders", "POST", "/v1/organizations/{organizationId}/rider-searches", "riders:read", "RIDER_INTAKE"],
  ["createTrip", "POST", "/v1/organizations/{organizationId}/trips", "trips:write", "RIDER_INTAKE"],
  ["getTrip", "GET", "/v1/organizations/{organizationId}/trips/{tripId}", "trips:read", "RIDER_INTAKE"],
  ["headTrip", "HEAD", "/v1/organizations/{organizationId}/trips/{tripId}", "trips:read", "RIDER_INTAKE"],
  ["cancelTrip", "POST", "/v1/organizations/{organizationId}/trips/{tripId}/commands/cancel", "trips:command", "RIDER_INTAKE"],
  ["getDispatchDay", "GET", "/v1/organizations/{organizationId}/dispatch-days/{serviceDate}", "dispatch:read", "ASSIGNED_SERVICE_DELIVERY"],
  ["getDriverManifest", "GET", "/v1/organizations/{organizationId}/driver/manifest", "driver:manifest:read", "ASSIGNED_SERVICE_DELIVERY"],
  ["submitDriverActionBatch", "POST", "/v1/organizations/{organizationId}/driver/action-batches", "driver:execute", "ASSIGNED_SERVICE_DELIVERY"],
  ["submitDriverLocationBatch", "POST", "/v1/organizations/{organizationId}/driver/location-batches", "driver:location:write", "ASSIGNED_SERVICE_DELIVERY"],
  ["getOperation", "GET", "/v1/organizations/{organizationId}/operations/{operationId}", "integrations:read", "PARTNER_EXPORT"]
].map(([id, method, path, capability, purpose]) => ({ operationId: id, method, path, capability, purpose, implementationState: "REGISTERED" }));

const catalog = {
  schemaVersion: "wp007.operation-catalog.v1",
  generatedFrom: { commandCatalog: "ARQ-003/1.0.0", apiDecision: "ARQ-007" },
  rules: { tenantAuthority: "authenticated-membership-plus-path-plus-RLS", defaultPageLimit: 50, maximumPageLimit: 200,
    ordinaryBodyBytes: 262144, actionBatchItems: 100, actionBatchBytes: 524288, locationBatchItems: 500, locationBatchBytes: 1048576,
    idempotencyRetentionHours: 24, openapi: "3.1.2" },
  resourceFamilies,
  liveOperations,
  commandMappings,
  explicitProhibitions,
};

await writeFile(resolve(root, "packages/api-contracts/artifacts/operation-catalog.json"), `${JSON.stringify(catalog, null, 2)}\n`);
console.log(`operation catalog: ${resourceFamilies.length} families, ${liveOperations.length} live operations, ${commandMappings.length} command mappings`);
