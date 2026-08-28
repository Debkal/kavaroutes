// Generated from WP007 OpenAPI 3.1.2; do not edit.
export const generatedClientPlatform = "react-native" as const;
export type AuditProjection = { readonly actionReference: string; readonly auditReference: OpaqueId; readonly occurredAt: Instant };
export type BatchReceipt = { readonly batchReference: OpaqueId; readonly items: ReadonlyArray<BatchReceiptItem>  };
export type BatchReceiptItem = { readonly clientItemId: OpaqueId; readonly code?: string; readonly outcome: "APPLIED" | "REPLAYED" | "REJECTED"; readonly resourceVersion?: number };
export type BillingProjection = { readonly amountMinor: number; readonly billingCaseReference: OpaqueId; readonly currency: string; readonly proofRecordedAt: Instant };
export type CancelTripRequest = { readonly reasonCode: "SYNTHETIC_REQUESTER_CANCELLED" | "SYNTHETIC_SERVICE_UNAVAILABLE" };
export type CommandReceipt = { readonly command: string; readonly outcome: "APPLIED" | "REPLAYED"; readonly resourceVersion: number };
export type CommercialTier = "SMALL_BUSINESS" | "ENTERPRISE";
export type DispatchDay = { readonly runs: ReadonlyArray<{ readonly lifecycle: string; readonly plannedEndAt: Instant; readonly plannedStartAt: Instant; readonly runId: OpaqueId }> ; readonly serviceDate: ServiceDate; readonly serviceTimezone: IanaTimezone; readonly snapshotVersion: number };
export type DispatcherTrip = { readonly lifecycle: "DRAFT" | "CANCELLED"; readonly resolvedServiceAt: Instant; readonly riderReference: OpaqueId; readonly serviceDate: ServiceDate; readonly serviceTimezone: IanaTimezone; readonly tripId: OpaqueId; readonly version: number };
export type DriverActionBatch = { readonly deviceSessionId: OpaqueId; readonly items: ReadonlyArray<DriverActionItem>  };
export type DriverActionItem = { readonly capturedAt: Instant; readonly clientActionId: OpaqueId; readonly command: "MARK_EN_ROUTE" | "ARRIVE_PICKUP" | "BOARD_RIDER" | "ARRIVE_DROPOFF" | "COMPLETE_LEG" | "REPORT_INCIDENT"; readonly deviceEpoch: number; readonly expectedTag: StrongEtag; readonly idempotencyKey: IdempotencyKey; readonly resourceReference: OpaqueId; readonly sequence: number } | { readonly capturedAt: Instant; readonly clientActionId: OpaqueId; readonly command: "COMPLETE_PRECHECK" | "COMPLETE_POSTCHECK"; readonly deviceEpoch: number; readonly expectedTag: StrongEtag; readonly idempotencyKey: IdempotencyKey; readonly policyDigest: string; readonly resourceReference: OpaqueId; readonly sequence: number } | { readonly capturedAt: Instant; readonly clientActionId: OpaqueId; readonly command: "SKIP_PRECHECK" | "SKIP_POSTCHECK"; readonly deviceEpoch: number; readonly expectedTag: StrongEtag; readonly idempotencyKey: IdempotencyKey; readonly policyDigest: string; readonly reasonCode: "OPTIONAL_CONTROL_SKIPPED" | "CONTROL_UNAVAILABLE"; readonly resourceReference: OpaqueId; readonly sequence: number } | { readonly capturedAt: Instant; readonly clientActionId: OpaqueId; readonly command: "PROPOSE_ROUTE_CHANGE"; readonly deviceEpoch: number; readonly expectedTag: StrongEtag; readonly idempotencyKey: IdempotencyKey; readonly policyDigest: string; readonly resourceReference: OpaqueId; readonly sequence: number } | { readonly capturedAt: Instant; readonly clientActionId: OpaqueId; readonly command: "REQUEST_CONTROL_OVERRIDE"; readonly deviceEpoch: number; readonly expectedTag: StrongEtag; readonly idempotencyKey: IdempotencyKey; readonly policyDigest: string; readonly reasonCode: "SAFETY_EXCEPTION" | "POLICY_OVERRIDE_REQUESTED"; readonly resourceReference: OpaqueId; readonly sequence: number };
export type DriverControlPolicy = { readonly commercialTier: CommercialTier; readonly controls: DriverControlSettings; readonly organizationId: OpaqueId; readonly version: number };
export type DriverControlReasonCode = "EXTERNAL_REQUIREMENT_APPLIED" | "ORGANIZATION_LOCK_APPLIED" | "ORGANIZATION_CONFIGURATION_APPLIED" | "SMALL_BUSINESS_OWNER_DEFAULT" | "SMALL_BUSINESS_WORKFORCE_PRESET" | "ENTERPRISE_STRICT_DEFAULT" | "SELF_APPROVAL_CAPABILITY_MISSING";
export type DriverControlSettings = { readonly endOdometer: { readonly locked: boolean; readonly mode: InspectionControlMode }; readonly postInspection: { readonly locked: boolean; readonly mode: InspectionControlMode }; readonly preInspection: { readonly locked: boolean; readonly mode: InspectionControlMode }; readonly returnVerification: { readonly locked: boolean; readonly mode: ReturnVerificationMode }; readonly routeChange: { readonly locked: boolean; readonly mode: RouteChangeMode }; readonly startOdometer: { readonly locked: boolean; readonly mode: InspectionControlMode } };
export type DriverControlSource = "EXTERNAL_FLOOR" | "ORGANIZATION_LOCK" | "ORGANIZATION_CONFIGURATION" | "WORKFORCE_PRESET" | "TIER_DEFAULT";
export type DriverManifest = { readonly assignments: ReadonlyArray<{ readonly assignmentReference: OpaqueId; readonly scheduledAt: Instant; readonly stopOrdinal: number; readonly syntheticLocationLabel: string }> ; readonly driverReference: OpaqueId; readonly effectivePolicy: EffectiveDriverPolicy; readonly effectivePolicyDigest: string; readonly serviceDate: ServiceDate; readonly serviceTimezone: IanaTimezone; readonly version: number };
export type EffectiveDriverPolicy = { readonly assignmentId: OpaqueId; readonly canonicalDigest: string; readonly commercialTier: CommercialTier; readonly driverId: OpaqueId; readonly endOdometer: ResolvedInspectionControl; readonly nonWaivableControls: readonly ["IDENTITY_AND_AUTHORIZATION", "TENANT_ISOLATION", "ENCRYPTION_AND_AUDIT", "MINIMUM_NECESSARY", "NO_PHI_NAVIGATION", "TRACKING_TRANSPARENCY", "EMERGENCY_STOP"]; readonly organizationId: OpaqueId; readonly policyVersion: number; readonly postInspection: ResolvedInspectionControl; readonly preInspection: ResolvedInspectionControl; readonly proofOfServicePolicy: "PAYER_CONTRACT_ORGANIZATION_RESOLVED"; readonly resolvedAt: Instant; readonly returnVerification: ResolvedReturnVerification; readonly routeChange: ResolvedRouteChange; readonly schemaVersion: 1; readonly startOdometer: ResolvedInspectionControl; readonly workforceRelationship: WorkforceRelationship };
export type FacilityTripProjection = { readonly lifecycle: string; readonly relatedTripReference: OpaqueId; readonly scheduledAt: Instant };
export type IanaTimezone = string;
export type IdempotencyKey = string;
export type InspectionControlMode = "DISABLED" | "OPTIONAL" | "REQUIRED";
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
export type ResolvedInspectionControl = { readonly locked: boolean; readonly mode: InspectionControlMode; readonly reasonCode: DriverControlReasonCode; readonly source: DriverControlSource };
export type ResolvedReturnVerification = { readonly locked: boolean; readonly mode: ReturnVerificationMode; readonly reasonCode: DriverControlReasonCode; readonly source: DriverControlSource };
export type ResolvedRouteChange = { readonly locked: boolean; readonly mode: RouteChangeMode; readonly reasonCode: DriverControlReasonCode; readonly source: DriverControlSource };
export type ReturnVerificationMode = "DISABLED" | "ADVISORY" | "REQUIRED_WITH_AUDITED_OVERRIDE";
export type RiderSearchRequest = { readonly limit?: number; readonly syntheticReferencePrefix: string };
export type RiderSearchResponse = { readonly items: ReadonlyArray<RiderSearchResult>  };
export type RiderSearchResult = { readonly riderId: OpaqueId; readonly syntheticDisplayLabel: string };
export type RouteChangeMode = "AUTHORIZED_SELF_APPROVE" | "DISPATCH_APPROVAL_REQUIRED" | "DISABLED";
export type ServiceDate = string;
export type StrongEtag = string;
export type TripCollection = { readonly items: ReadonlyArray<DispatcherTrip> ; readonly page: Page };
export type TripCommandResponse = { readonly receipt: CommandReceipt; readonly trip: DispatcherTrip };
export type TripCreateRequest = { readonly ambiguityPolicy: "reject" | "earlier" | "later"; readonly localServiceTime: string; readonly resolvedServiceAt: Instant; readonly resolvedUtcOffsetSeconds: number; readonly riderId: OpaqueId; readonly serviceDate: ServiceDate; readonly serviceTimezone: IanaTimezone; readonly tripId: OpaqueId };
export type UpdateDriverControlPolicy = { readonly controls: DriverControlSettings; readonly reasonCode: "OWNER_ENABLED_STRICT_PRESET" | "OPERATING_POLICY_CHANGED" | "EXTERNAL_REQUIREMENT_CHANGED"; readonly secondApprovalReference?: OpaqueId };
export type WorkforceRelationship = "OWNER_OPERATOR" | "EMPLOYEE" | "CONTRACTOR";

export interface FetchLike { (path: string, init?: { readonly method?: string; readonly headers?: Readonly<Record<string,string>>; readonly body?: string }): Promise<{ readonly status: number; json(): Promise<unknown> }>; }
export function decodeDispatcherTrip(value: unknown): DispatcherTrip {
  if (typeof value !== "object" || value === null) throw new Error("INVALID_TRIP_RESPONSE");
  const source = value as Record<string, unknown>;
  if (typeof source.tripId !== "string" || typeof source.riderReference !== "string" || typeof source.version !== "number") throw new Error("INVALID_TRIP_RESPONSE");
  return { tripId: source.tripId, riderReference: source.riderReference, serviceDate: String(source.serviceDate), serviceTimezone: String(source.serviceTimezone), resolvedServiceAt: String(source.resolvedServiceAt), lifecycle: source.lifecycle as DispatcherTrip["lifecycle"], version: source.version };
}
export function decodeEffectiveDriverPolicy(value: unknown): EffectiveDriverPolicy {
  if (typeof value !== "object" || value === null) throw new Error("INVALID_DRIVER_POLICY_RESPONSE");
  const source = value as Record<string, unknown>; const tier = source.commercialTier; const relationship = source.workforceRelationship;
  if (!(["SMALL_BUSINESS","ENTERPRISE"] as const).includes(tier as CommercialTier) || !(["OWNER_OPERATOR","EMPLOYEE","CONTRACTOR"] as const).includes(relationship as WorkforceRelationship) || typeof source.canonicalDigest !== "string" || !/^[a-f0-9]{64}$/.test(source.canonicalDigest)) throw new Error("INVALID_DRIVER_POLICY_RESPONSE");
  const inspection = [source.preInspection, source.postInspection, source.startOdometer, source.endOdometer] as unknown[];
  if (inspection.some((control) => typeof control !== "object" || control === null || !(["DISABLED","OPTIONAL","REQUIRED"] as const).includes((control as { mode?: unknown }).mode as InspectionControlMode))) throw new Error("INVALID_DRIVER_POLICY_RESPONSE");
  if (typeof source.returnVerification !== "object" || source.returnVerification === null || !(["DISABLED","ADVISORY","REQUIRED_WITH_AUDITED_OVERRIDE"] as const).includes((source.returnVerification as { mode?: unknown }).mode as ReturnVerificationMode)) throw new Error("INVALID_DRIVER_POLICY_RESPONSE");
  if (typeof source.routeChange !== "object" || source.routeChange === null || !(["AUTHORIZED_SELF_APPROVE","DISPATCH_APPROVAL_REQUIRED","DISABLED"] as const).includes((source.routeChange as { mode?: unknown }).mode as RouteChangeMode)) throw new Error("INVALID_DRIVER_POLICY_RESPONSE");
  return source as unknown as EffectiveDriverPolicy;
}
export function decodeDriverManifest(value: unknown): DriverManifest {
  if (typeof value !== "object" || value === null) throw new Error("INVALID_DRIVER_MANIFEST_RESPONSE"); const source = value as Record<string, unknown>; const effectivePolicy = decodeEffectiveDriverPolicy(source.effectivePolicy);
  if (typeof source.driverReference !== "string" || typeof source.version !== "number" || !Array.isArray(source.assignments) || source.effectivePolicyDigest !== effectivePolicy.canonicalDigest) throw new Error("INVALID_DRIVER_MANIFEST_RESPONSE");
  return { ...source, effectivePolicy } as unknown as DriverManifest;
}
export function createKavaRoutesClient(fetcher: FetchLike) { return Object.freeze({ async getTrip(path: string, authorization: string) { const response = await fetcher(path, { headers: { authorization } }); if (response.status !== 200) throw new Error("API_PROBLEM"); return decodeDispatcherTrip(await response.json()); }, async getDriverManifest(path: string, authorization: string) { const response = await fetcher(path, { headers: { authorization } }); if (response.status !== 200) throw new Error("API_PROBLEM"); return decodeDriverManifest(await response.json()); } }); }
