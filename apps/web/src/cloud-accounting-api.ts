import { createPrivateDevelopmentTransport, type DevelopmentFetch } from "@kavaroutes/api-contracts/private-development-transport";
import type { RouteCostProfile } from "@kavaroutes/api-contracts/route-costing";

/**
 * The accounting surface's own scoped transport. It runs as the billing principal
 * (`billing:read` / `billing:command`, BILLING_PROOF), so money data is never read or
 * changed through the dispatch board's authority.
 */
const organizationId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const prefix = `/v1/organizations/${organizationId}`;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("INVALID_ACCOUNTING_RESPONSE");
  return value as Record<string, unknown>;
};
const integer = (value: unknown, minimum = 0, maximum = 2_000_000_000) => {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) throw new Error("INVALID_ACCOUNTING_RESPONSE");
  return Number(value);
};
const money = (value: unknown) => integer(value, 0);
const text = (value: unknown, max = 512) => {
  if (typeof value !== "string" || value.length > max) throw new Error("INVALID_ACCOUNTING_RESPONSE");
  return value;
};
const nullableText = (value: unknown, max = 512) => value === null || value === undefined ? null : text(value, max);

function decodeProfile(value: unknown): RouteCostProfile {
  const row = object(value);
  return {
    fuelCentsPerGallon: integer(row.fuelCentsPerGallon, 1, 5000), fuelEfficiencyMpg: Number(row.fuelEfficiencyMpg),
    maintenanceCentsPerMile: integer(row.maintenanceCentsPerMile, 0, 1000), driverHourlyCents: integer(row.driverHourlyCents, 0, 20000),
    driverBurdenPercent: Number(row.driverBurdenPercent), insuranceCentsPerMonthPerVehicle: money(row.insuranceCentsPerMonthPerVehicle),
    fixedOverheadCentsPerMonth: money(row.fixedOverheadCentsPerMonth), deadheadPercent: Number(row.deadheadPercent),
    targetMarginPercent: Number(row.targetMarginPercent), contractedBaseCents: money(row.contractedBaseCents),
    contractedCentsPerMile: integer(row.contractedCentsPerMile, 0, 100000), averageTripMiles: Number(row.averageTripMiles),
    loadedMilesPerHour: Number(row.loadedMilesPerHour),
  };
}
const decodeProfileView = (value: unknown) => {
  const row = object(value);
  return { profile: row.profile === null || row.profile === undefined ? null : decodeProfile(row.profile), version: integer(row.version, 0) };
};
const decodeTrip = (value: unknown) => {
  const row = object(value);
  return { tripId: text(row.tripId, 36), clientId: nullableText(row.clientId, 36), clientLabel: nullableText(row.clientLabel, 200),
    riderLabel: nullableText(row.riderLabel, 200), pickupLabel: text(row.pickupLabel), dropoffLabel: text(row.dropoffLabel),
    plannedStartAt: text(row.plannedStartAt, 35), plannedEndAt: text(row.plannedEndAt, 35),
    appointmentLengthMinutes: integer(row.appointmentLengthMinutes, 0, 1440),
    measuredMiles: row.measuredMiles === null || row.measuredMiles === undefined ? null : Number(row.measuredMiles),
    driverLabel: nullableText(row.driverLabel, 200), recordState: text(row.recordState, 32), executionState: text(row.executionState, 64) };
};
const decodeInvoice = (value: unknown) => {
  const row = object(value);
  return { invoiceId: text(row.invoiceId, 36), clientId: nullableText(row.clientId, 36), clientLabel: nullableText(row.clientLabel, 200),
    payerKind: text(row.payerKind, 32), payerName: text(row.payerName, 200), claimReference: nullableText(row.claimReference, 64),
    periodStart: text(row.periodStart, 10), periodEnd: text(row.periodEnd, 10), status: text(row.status, 10),
    totalCents: money(row.totalCents), totalMiles: Number(row.totalMiles), lineCount: integer(row.lineCount, 0, 500),
    forwardedAt: nullableText(row.forwardedAt, 35), forwardedMethod: nullableText(row.forwardedMethod, 10),
    forwardedTo: nullableText(row.forwardedTo, 200), aggregateVersion: integer(row.aggregateVersion, 1),
    createdAt: text(row.createdAt, 35) };
};

export function createCloudAccountingApi(baseUrl: string, fetcher: DevelopmentFetch) {
  // Every other web surface allows the same-origin HTTPS edge prototype; the accounting
  // transport must too, or the deployed tab throws PRIVATE_DEVELOPMENT_LOOPBACK_REQUIRED
  // while the shell still answers 200.
  const browserSameOrigin = new URL(baseUrl).protocol === "https:";
  const transport = createPrivateDevelopmentTransport({ baseUrl, persona: "billing", fetch: fetcher, browserSameOrigin });
  return Object.freeze({
    costProfile(signal?: AbortSignal) { return transport.request(`${prefix}/billing/cost-profile`, decodeProfileView, undefined, signal); },
    updateCostProfile(profile: RouteCostProfile, expectedVersion: number, key: string) {
      return transport.request(`${prefix}/billing/cost-profile/commands/update`, value => ({ version: integer(object(value).version, 1) }),
        { body: { ...profile, expectedVersion }, idempotencyKey: key });
    },
    estimates(serviceDate: string, signal?: AbortSignal) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(serviceDate)) throw new Error("INVALID_SERVICE_DATE");
      return transport.request(`${prefix}/billing/estimates/${serviceDate}`, value => {
        const row = object(value);
        if (!Array.isArray(row.trips)) throw new Error("INVALID_ACCOUNTING_RESPONSE");
        return { serviceDate: text(row.serviceDate, 10), version: integer(row.version, 0),
          profile: row.profile === null || row.profile === undefined ? null : decodeProfile(row.profile), trips: row.trips.map(decodeTrip) };
      }, undefined, signal);
    },
    invoices(limit = 50, signal?: AbortSignal) {
      return transport.request(`${prefix}/billing/invoices?limit=${limit}`, value => {
        const row = object(value);
        if (!Array.isArray(row.invoices)) throw new Error("INVALID_ACCOUNTING_RESPONSE");
        return { invoices: row.invoices.map(decodeInvoice) };
      }, undefined, signal);
    },
    invoice(invoiceId: string, signal?: AbortSignal) {
      if (!uuid.test(invoiceId)) throw new Error("INVALID_INVOICE");
      return transport.request(`${prefix}/billing/invoices/${invoiceId}`, value => {
        const row = object(value);
        if (!Array.isArray(row.lines)) throw new Error("INVALID_ACCOUNTING_RESPONSE");
        return { ...decodeInvoice(row), lines: row.lines.map(line => {
          const item = object(line);
          return { ordinal: integer(item.ordinal, 1, 500), tripId: text(item.tripId, 36), serviceDate: text(item.serviceDate, 10),
            description: text(item.description, 300), miles: Number(item.miles), hcpcsCode: nullableText(item.hcpcsCode, 8),
            authorizationNumber: nullableText(item.authorizationNumber, 64), proofOfService: text(item.proofOfService, 24),
            amountCents: money(item.amountCents) };
        }) };
      }, undefined, signal);
    },
    createInvoice(request: Record<string, unknown>, key: string) {
      return transport.request(`${prefix}/billing/invoices/commands/create`, value => {
        const row = object(value);
        return { invoiceId: text(row.invoiceId, 36), totalCents: money(row.totalCents), totalMiles: Number(row.totalMiles),
          lineCount: integer(row.lineCount, 1, 500), sumMinutes: integer(row.sumMinutes, 0) };
      }, { body: request, idempotencyKey: key });
    },
    forwardInvoice(invoiceId: string, request: { expectedVersion: number; method: string; forwardedTo: string; claimReference: string | null }, key: string) {
      if (!uuid.test(invoiceId)) throw new Error("INVALID_INVOICE");
      return transport.request(`${prefix}/billing/invoices/${invoiceId}/commands/forward`, value => {
        const row = object(value);
        return { invoiceId: text(row.invoiceId, 36), status: text(row.status, 10), aggregateVersion: integer(row.aggregateVersion, 1) };
      }, { body: request, idempotencyKey: key });
    },
    clientHistory(clientId: string, days: number, signal?: AbortSignal) {
      if (!uuid.test(clientId)) throw new Error("INVALID_CLIENT");
      return transport.request(`${prefix}/clients/${clientId}/history?days=${days}`, value => {
        const row = object(value);
        if (!Array.isArray(row.trips)) throw new Error("INVALID_ACCOUNTING_RESPONSE");
        const totals = object(row.totals);
        return { clientId: text(row.clientId, 36), days: integer(row.days, 1, 3650),
          trips: row.trips.map(trip => { const item = object(trip);
            return { tripId: text(item.tripId, 36), serviceDate: text(item.serviceDate, 10), pickupLabel: nullableText(item.pickupLabel),
              dropoffLabel: nullableText(item.dropoffLabel), plannedStartAt: text(item.plannedStartAt, 35),
              appointmentLengthMinutes: integer(item.appointmentLengthMinutes, 0, 1440), tripState: text(item.tripState, 64),
              executionState: text(item.executionState, 64), driverLabel: nullableText(item.driverLabel, 200),
              measuredMiles: item.measuredMiles === null || item.measuredMiles === undefined ? null : Number(item.measuredMiles),
              proofCount: integer(item.proofCount, 0) }; }),
          totals: { trips: integer(totals.trips, 0), delivered: integer(totals.delivered, 0), cancelled: integer(totals.cancelled, 0),
            measuredMiles: Number(totals.measuredMiles), appointmentMinutes: integer(totals.appointmentMinutes, 0),
            tripsWithProof: integer(totals.tripsWithProof, 0) } };
      }, undefined, signal);
    },
  });
}
