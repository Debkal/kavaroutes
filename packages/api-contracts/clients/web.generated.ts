// Generated from WP007 OpenAPI 3.1.2; do not edit.
export const generatedClientPlatform = "web" as const;
export type AuditProjection = { readonly actionReference: string; readonly auditReference: OpaqueId; readonly occurredAt: Instant };
export type BatchReceipt = { readonly batchReference: OpaqueId; readonly items: ReadonlyArray<BatchReceiptItem>  };
export type BatchReceiptItem = { readonly clientItemId: OpaqueId; readonly code?: string; readonly outcome: "APPLIED" | "REPLAYED" | "REJECTED"; readonly resourceVersion?: number };
export type BillingProjection = { readonly amountMinor: number; readonly billingCaseReference: OpaqueId; readonly currency: string; readonly proofRecordedAt: Instant };
export type CancelTripRequest = { readonly reasonCode: "SYNTHETIC_REQUESTER_CANCELLED" | "SYNTHETIC_SERVICE_UNAVAILABLE" };
export type CommandReceipt = { readonly command: string; readonly outcome: "APPLIED" | "REPLAYED"; readonly resourceVersion: number };
export type DispatchDay = { readonly runs: ReadonlyArray<{ readonly lifecycle: string; readonly plannedEndAt: Instant; readonly plannedStartAt: Instant; readonly runId: OpaqueId }> ; readonly serviceDate: ServiceDate; readonly serviceTimezone: IanaTimezone; readonly snapshotVersion: number };
export type DispatcherTrip = { readonly lifecycle: "DRAFT" | "CANCELLED"; readonly resolvedServiceAt: Instant; readonly riderReference: OpaqueId; readonly serviceDate: ServiceDate; readonly serviceTimezone: IanaTimezone; readonly tripId: OpaqueId; readonly version: number };
export type DriverActionBatch = { readonly deviceSessionId: OpaqueId; readonly items: ReadonlyArray<DriverActionItem>  };
export type DriverActionItem = { readonly capturedAt: Instant; readonly clientActionId: OpaqueId; readonly command: "MARK_EN_ROUTE" | "ARRIVE_PICKUP" | "BOARD_RIDER" | "ARRIVE_DROPOFF" | "COMPLETE_LEG" | "REPORT_INCIDENT"; readonly deviceEpoch: number; readonly expectedTag: StrongEtag; readonly idempotencyKey: IdempotencyKey; readonly resourceReference: OpaqueId; readonly sequence: number };
export type DriverManifest = { readonly assignments: ReadonlyArray<{ readonly assignmentReference: OpaqueId; readonly scheduledAt: Instant; readonly stopOrdinal: number; readonly syntheticLocationLabel: string }> ; readonly driverReference: OpaqueId; readonly serviceDate: ServiceDate; readonly serviceTimezone: IanaTimezone; readonly version: number };
export type FacilityTripProjection = { readonly lifecycle: string; readonly relatedTripReference: OpaqueId; readonly scheduledAt: Instant };
export type IanaTimezone = string;
export type IdempotencyKey = string;
export type Instant = string;
export type IntegrationProjection = { readonly outcome: "ACCEPTED" | "REJECTED" | "PARTIAL"; readonly receiptReference: OpaqueId };
export type LocationBatch = { readonly deviceId: OpaqueId; readonly samples: ReadonlyArray<LocationSample>  };
export type LocationSample = { readonly capturedAt: Instant; readonly deviceEpoch: number; readonly latitude: number; readonly longitude: number; readonly sampleId: OpaqueId; readonly sequence: number };
export type MeResponse = { readonly organizations: ReadonlyArray<OrganizationMembership> ; readonly policyVersion: "privacy-synthetic-v1"; readonly principalId: OpaqueId; readonly principalKind: "SYNTHETIC_USER" | "SYNTHETIC_DEVICE" };
export type OpaqueId = string;
export type Operation = { readonly createdAt: Instant; readonly expiresAt: Instant; readonly operationId: OpaqueId; readonly problemLink?: string; readonly progress: { readonly completed: number; readonly total: number }; readonly resultLink?: string; readonly state: "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED" | "CANCELLED" | "EXPIRED"; readonly updatedAt: Instant };
export type OrganizationMembership = { readonly capabilities: ReadonlyArray<string> ; readonly organizationId: OpaqueId };
export type Page = { readonly asOf: Instant; readonly limit: number; readonly nextCursor: string | null };
export type Problem = { readonly code: string; readonly detail: string; readonly errors?: ReadonlyArray<ProblemError> ; readonly instance: string; readonly requestId: string; readonly status: number; readonly title: string; readonly type: string };
export type ProblemError = { readonly code: string; readonly pointer: string };
export type RiderSearchRequest = { readonly limit?: number; readonly syntheticReferencePrefix: string };
export type RiderSearchResponse = { readonly items: ReadonlyArray<RiderSearchResult>  };
export type RiderSearchResult = { readonly riderId: OpaqueId; readonly syntheticDisplayLabel: string };
export type ServiceDate = string;
export type StrongEtag = string;
export type TripCollection = { readonly items: ReadonlyArray<DispatcherTrip> ; readonly page: Page };
export type TripCommandResponse = { readonly receipt: CommandReceipt; readonly trip: DispatcherTrip };
export type TripCreateRequest = { readonly ambiguityPolicy: "reject" | "earlier" | "later"; readonly localServiceTime: string; readonly resolvedServiceAt: Instant; readonly resolvedUtcOffsetSeconds: number; readonly riderId: OpaqueId; readonly serviceDate: ServiceDate; readonly serviceTimezone: IanaTimezone; readonly tripId: OpaqueId };

export interface FetchLike { (path: string, init?: { readonly method?: string; readonly headers?: Readonly<Record<string,string>>; readonly body?: string }): Promise<{ readonly status: number; json(): Promise<unknown> }>; }
export function decodeDispatcherTrip(value: unknown): DispatcherTrip {
  if (typeof value !== "object" || value === null) throw new Error("INVALID_TRIP_RESPONSE");
  const source = value as Record<string, unknown>;
  if (typeof source.tripId !== "string" || typeof source.riderReference !== "string" || typeof source.version !== "number") throw new Error("INVALID_TRIP_RESPONSE");
  return { tripId: source.tripId, riderReference: source.riderReference, serviceDate: String(source.serviceDate), serviceTimezone: String(source.serviceTimezone), resolvedServiceAt: String(source.resolvedServiceAt), lifecycle: source.lifecycle as DispatcherTrip["lifecycle"], version: source.version };
}
export function createKavaRoutesClient(fetcher: FetchLike) { return Object.freeze({ async getTrip(path: string, authorization: string) { const response = await fetcher(path, { headers: { authorization } }); if (response.status !== 200) throw new Error("API_PROBLEM"); return decodeDispatcherTrip(await response.json()); } }); }
