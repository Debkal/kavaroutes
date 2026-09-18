import type { Pool } from 'pg';
import { Type,type Static } from 'typebox';
import { createAccountingService } from '@kavaroutes/postgres-persistence';
import { authorize,type SyntheticPrincipal } from './security.js';
import { ProtocolError } from './protocol.js';

/**
 * Accounting for dispatch: what a route costs, what it must be charged, which delivered
 * trips are on an invoice, and where that invoice was sent. Reads need `billing:read` and
 * commands `billing:command`, both under the BILLING_PROOF purpose, so the money surface is
 * its own authority rather than a side effect of running the board.
 */
const closed = { additionalProperties: false } as const;
const nullable = <T extends Parameters<typeof Type.Union>[0][number]>(schema: T) => Type.Union([schema, Type.Null()]);
const cents = Type.Integer({ minimum: 0, maximum: 2_000_000_000 });
const profileFields = {
  fuelCentsPerGallon: Type.Integer({ minimum: 1, maximum: 5000 }),
  fuelEfficiencyMpg: Type.Number({ minimum: 1, maximum: 60 }),
  maintenanceCentsPerMile: Type.Integer({ minimum: 0, maximum: 1000 }),
  driverHourlyCents: Type.Integer({ minimum: 0, maximum: 20000 }),
  driverBurdenPercent: Type.Number({ minimum: 0, maximum: 100 }),
  insuranceCentsPerMonthPerVehicle: cents,
  fixedOverheadCentsPerMonth: cents,
  deadheadPercent: Type.Number({ minimum: 0, maximum: 100 }),
  targetMarginPercent: Type.Number({ minimum: 0, maximum: 90 }),
  contractedBaseCents: cents,
  contractedCentsPerMile: Type.Integer({ minimum: 0, maximum: 100000 }),
  averageTripMiles: Type.Number({ minimum: 0.5, maximum: 500 }),
  loadedMilesPerHour: Type.Number({ minimum: 1, maximum: 80 }),
} as const;

export const RouteCostProfileSchema = Type.Object(profileFields, { ...closed, $id: 'RouteCostProfile' });
export const CostProfileViewSchema = Type.Object({ profile: nullable(RouteCostProfileSchema), version: Type.Integer({ minimum: 0 }) },
  { ...closed, $id: 'CostProfileView' });
export const CostProfileUpdateRequestSchema = Type.Object({ ...profileFields, expectedVersion: Type.Integer({ minimum: 0 }) },
  { ...closed, $id: 'CostProfileUpdateRequest' });
export const CostProfileUpdateReceiptSchema = Type.Object({ version: Type.Integer({ minimum: 1 }) }, { ...closed, $id: 'CostProfileUpdateReceipt' });

export const ServiceDayEstimateTripSchema = Type.Object({
  tripId: Type.String({ format: 'uuid' }), clientId: nullable(Type.String({ format: 'uuid' })),
  clientLabel: nullable(Type.String({ maxLength: 200 })), riderLabel: nullable(Type.String({ maxLength: 200 })),
  pickupLabel: Type.String({ maxLength: 512 }), dropoffLabel: Type.String({ maxLength: 512 }),
  plannedStartAt: Type.String({ format: 'date-time', maxLength: 35 }), plannedEndAt: Type.String({ format: 'date-time', maxLength: 35 }),
  appointmentLengthMinutes: Type.Integer({ minimum: 0, maximum: 1440 }),
  measuredMiles: nullable(Type.Number({ minimum: 0, maximum: 20000 })),
  driverLabel: nullable(Type.String({ maxLength: 200 })), recordState: Type.String({ maxLength: 32 }),
  executionState: Type.String({ maxLength: 64 }),
}, { ...closed, $id: 'ServiceDayEstimateTrip' });
export const ServiceDayEstimatesSchema = Type.Object({
  serviceDate: Type.String({ format: 'date', maxLength: 10 }), version: Type.Integer({ minimum: 0 }),
  profile: nullable(RouteCostProfileSchema), trips: Type.Array(ServiceDayEstimateTripSchema, { maxItems: 300 }),
}, { ...closed, $id: 'ServiceDayEstimates' });

export const payerKinds = ['MEDICAID', 'BROKER', 'MCO', 'COMMERCIAL_INSURANCE', 'WORKERS_COMPENSATION', 'AUTO_LIABILITY', 'FACILITY', 'PATIENT', 'OTHER'] as const;
export const proofOfServiceKinds = ['SIGNATURE_ON_FILE', 'FACILITY_SIGNATURE', 'DRIVER_ATTESTED', 'NOT_REQUIRED', 'MISSING'] as const;
export const InvoiceCreateRequestSchema = Type.Object({
  periodStart: Type.String({ format: 'date', maxLength: 10 }), periodEnd: Type.String({ format: 'date', maxLength: 10 }),
  clientId: nullable(Type.String({ format: 'uuid' })),
  payerKind: Type.String({ enum: payerKinds }), payerName: Type.String({ minLength: 1, maxLength: 200 }),
  claimReference: nullable(Type.String({ maxLength: 64 })),
  hcpcsCode: nullable(Type.String({ pattern: '^[A-Z][0-9]{4}$' })),
  authorizationNumber: nullable(Type.String({ maxLength: 64 })),
  proofOfService: Type.String({ enum: proofOfServiceKinds }),
}, { ...closed, $id: 'InvoiceCreateRequest' });
export const InvoiceReceiptSchema = Type.Object({ invoiceId: Type.String({ format: 'uuid' }), totalCents: cents,
  totalMiles: Type.Number({ minimum: 0 }), lineCount: Type.Integer({ minimum: 1 }), sumMinutes: Type.Integer({ minimum: 0 }) },
{ ...closed, $id: 'InvoiceReceipt' });
export const InvoiceSummarySchema = Type.Object({
  invoiceId: Type.String({ format: 'uuid' }), clientId: nullable(Type.String({ format: 'uuid' })), clientLabel: nullable(Type.String({ maxLength: 200 })),
  payerKind: Type.String({ enum: payerKinds }), payerName: Type.String({ maxLength: 200 }),
  claimReference: nullable(Type.String({ maxLength: 64 })),
  periodStart: Type.String({ format: 'date', maxLength: 10 }), periodEnd: Type.String({ format: 'date', maxLength: 10 }),
  status: Type.String({ enum: ['DRAFT', 'READY', 'SENT', 'PAID', 'VOID'] }), totalCents: cents, totalMiles: Type.Number({ minimum: 0 }),
  lineCount: Type.Integer({ minimum: 0 }), forwardedAt: nullable(Type.String({ format: 'date-time', maxLength: 35 })),
  forwardedMethod: nullable(Type.String({ enum: ['EXPORT', 'EMAIL', 'PORTAL', 'POST'] })), forwardedTo: nullable(Type.String({ maxLength: 200 })),
  aggregateVersion: Type.Integer({ minimum: 1 }), createdAt: Type.String({ format: 'date-time', maxLength: 35 }),
}, { ...closed, $id: 'InvoiceSummary' });
export const InvoiceLineSchema = Type.Object({ ordinal: Type.Integer({ minimum: 1 }), tripId: Type.String({ format: 'uuid' }),
  serviceDate: Type.String({ format: 'date', maxLength: 10 }), description: Type.String({ maxLength: 300 }), miles: Type.Number({ minimum: 0 }),
  hcpcsCode: nullable(Type.String({ pattern: '^[A-Z][0-9]{4}$' })), authorizationNumber: nullable(Type.String({ maxLength: 64 })),
  proofOfService: Type.String({ enum: proofOfServiceKinds }), amountCents: cents }, { ...closed, $id: 'InvoiceLine' });
export const InvoiceViewSchema = Type.Object({ ...InvoiceSummarySchema.properties, lines: Type.Array(InvoiceLineSchema, { maxItems: 500 }) },
  { ...closed, $id: 'InvoiceView' });
export const InvoiceListSchema = Type.Object({ invoices: Type.Array(InvoiceSummarySchema, { maxItems: 200 }) }, { ...closed, $id: 'InvoiceList' });
export const InvoiceForwardRequestSchema = Type.Object({ expectedVersion: Type.Integer({ minimum: 1 }),
  method: Type.String({ enum: ['EXPORT', 'EMAIL', 'PORTAL', 'POST'] }), forwardedTo: Type.String({ minLength: 1, maxLength: 200 }),
  claimReference: nullable(Type.String({ maxLength: 64 })) }, { ...closed, $id: 'InvoiceForwardRequest' });
export const InvoiceForwardReceiptSchema = Type.Object({ invoiceId: Type.String({ format: 'uuid' }),
  status: Type.Literal('SENT'), aggregateVersion: Type.Integer({ minimum: 1 }) }, { ...closed, $id: 'InvoiceForwardReceipt' });

export const ClientHistoryTripSchema = Type.Object({
  tripId: Type.String({ format: 'uuid' }), serviceDate: Type.String({ format: 'date', maxLength: 10 }),
  pickupLabel: nullable(Type.String({ maxLength: 512 })), dropoffLabel: nullable(Type.String({ maxLength: 512 })),
  plannedStartAt: Type.String({ format: 'date-time', maxLength: 35 }), appointmentLengthMinutes: Type.Integer({ minimum: 0, maximum: 1440 }),
  tripState: Type.String({ maxLength: 64 }), executionState: Type.String({ maxLength: 64 }),
  driverLabel: nullable(Type.String({ maxLength: 200 })), measuredMiles: nullable(Type.Number({ minimum: 0 })),
  proofCount: Type.Integer({ minimum: 0 }),
}, { ...closed, $id: 'ClientHistoryTrip' });
export const ClientHistorySchema = Type.Object({
  clientId: Type.String({ format: 'uuid' }), days: Type.Integer({ minimum: 1, maximum: 3650 }),
  trips: Type.Array(ClientHistoryTripSchema, { maxItems: 500 }),
  totals: Type.Object({ trips: Type.Integer({ minimum: 0 }), delivered: Type.Integer({ minimum: 0 }), cancelled: Type.Integer({ minimum: 0 }),
    measuredMiles: Type.Number({ minimum: 0 }), appointmentMinutes: Type.Integer({ minimum: 0 }), tripsWithProof: Type.Integer({ minimum: 0 }) }, closed),
}, { ...closed, $id: 'ClientHistory' });

export type CostProfileUpdateRequest = Static<typeof CostProfileUpdateRequestSchema>;
export type InvoiceCreateRequest = Static<typeof InvoiceCreateRequestSchema>;
export type InvoiceForwardRequest = Static<typeof InvoiceForwardRequestSchema>;

export function createPostgresAccountingApiService(pool: Pool) {
  const accounting = createAccountingService(pool);
  const read = (principal: SyntheticPrincipal, organizationId: string) =>
    authorize(principal, organizationId, { capability: 'billing:read', purpose: 'BILLING_PROOF' });
  const command = (principal: SyntheticPrincipal, organizationId: string) =>
    authorize(principal, organizationId, { capability: 'billing:command', purpose: 'BILLING_PROOF' });
  return Object.freeze({
    async costProfile(principal: SyntheticPrincipal, organizationId: string) { read(principal, organizationId); return accounting.readCostProfile(organizationId); },
    async updateCostProfile(principal: SyntheticPrincipal, organizationId: string, request: CostProfileUpdateRequest) {
      command(principal, organizationId);
      const { expectedVersion, ...profile } = request;
      return accounting.updateCostProfile(organizationId, { ...profile, expectedVersion });
    },
    async estimates(principal: SyntheticPrincipal, organizationId: string, serviceDate: string) { read(principal, organizationId); return accounting.readServiceDayEstimates(organizationId, serviceDate); },
    async invoices(principal: SyntheticPrincipal, organizationId: string, limit: number) { read(principal, organizationId); return { invoices: await accounting.listInvoices(organizationId, limit) }; },
    async invoice(principal: SyntheticPrincipal, organizationId: string, invoiceId: string) {
      read(principal, organizationId);
      const invoice = await accounting.readInvoice(organizationId, invoiceId);
      if (!invoice) throw new ProtocolError(404, 'RESOURCE_NOT_FOUND', 'resource hidden');
      return invoice;
    },
    async createInvoice(principal: SyntheticPrincipal, organizationId: string, request: InvoiceCreateRequest) { command(principal, organizationId); return accounting.createInvoice(organizationId, request); },
    async forwardInvoice(principal: SyntheticPrincipal, organizationId: string, invoiceId: string, request: InvoiceForwardRequest) {
      command(principal, organizationId);
      return accounting.forwardInvoice(organizationId, principal.id, { invoiceId,
        expectedVersion: request.expectedVersion, method: request.method as 'EXPORT' | 'EMAIL' | 'PORTAL' | 'POST',
        forwardedTo: request.forwardedTo, claimReference: request.claimReference });
    },
    async clientHistory(principal: SyntheticPrincipal, organizationId: string, clientId: string, days: number) { read(principal, organizationId); return accounting.readClientHistory(organizationId, clientId, days); },
  });
}
export type InvoiceView = { readonly lines: readonly Static<typeof InvoiceLineSchema>[] } & Static<typeof InvoiceSummarySchema>;
export type AccountingApiService = ReturnType<typeof createPostgresAccountingApiService>;
