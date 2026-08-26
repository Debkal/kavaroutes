import type { Capability, Purpose, SyntheticPrincipal } from "@kavaroutes/api-contracts";
import type { NormalizedScope, SubscriptionPurpose } from "./contracts.js";

export interface AuthorizedSubscription {
  readonly organizationId: string;
  readonly principalId: string;
  readonly authorizationGeneration: number;
  readonly purpose: SubscriptionPurpose;
  readonly scope: NormalizedScope;
  readonly allowedDeltaKinds: ReadonlySet<string>;
  readonly costUnits: number;
}

export class RealtimeAuthorizationDenied extends Error {
  constructor(readonly safeCode: "ORGANIZATION_DENIED" | "CAPABILITY_DENIED" | "PURPOSE_DENIED" | "RELATIONSHIP_DENIED" | "SCOPE_DENIED" | "COST_LIMIT") {
    super("REALTIME_AUTHORIZATION_DENIED");
    this.name = "RealtimeAuthorizationDenied";
  }
}

interface Rule {
  readonly streamKind: NormalizedScope["streamKind"];
  readonly capability: Capability;
  readonly domainPurpose: Purpose;
  readonly deltaKinds: readonly string[];
  readonly relationship: "BRANCH" | "FLEET" | "SUBJECT";
  readonly costUnits: number;
}

const RULES: Readonly<Record<SubscriptionPurpose, Rule>> = Object.freeze({
  DISPATCH_CONTROL: { streamKind: "DISPATCH_DAY", capability: "dispatch:read", domainPurpose: "ASSIGNED_SERVICE_DELIVERY", deltaKinds: ["RESOURCE_INVALIDATED", "DISPATCH_CONTROL"], relationship: "BRANCH", costUnits: 2 },
  DRIVER_MANIFEST: { streamKind: "DRIVER_MANIFEST", capability: "driver:manifest:read", domainPurpose: "ASSIGNED_SERVICE_DELIVERY", deltaKinds: ["RESOURCE_INVALIDATED", "DRIVER_MANIFEST"], relationship: "SUBJECT", costUnits: 1 },
  FACILITY_COORDINATION: { streamKind: "FACILITY_DAY", capability: "facility:trip-status:read", domainPurpose: "FACILITY_COORDINATION", deltaKinds: ["RESOURCE_INVALIDATED", "FACILITY_COORDINATION"], relationship: "SUBJECT", costUnits: 1 },
  OPERATION_PROGRESS: { streamKind: "OPERATION", capability: "dispatch:read", domainPurpose: "ASSIGNED_SERVICE_DELIVERY", deltaKinds: ["RESOURCE_INVALIDATED", "OPERATION_PROGRESS"], relationship: "BRANCH", costUnits: 1 },
  DISPATCH_CURRENT_POSITION: { streamKind: "CURRENT_POSITION", capability: "dispatch:location:read", domainPurpose: "ASSIGNED_SERVICE_DELIVERY", deltaKinds: ["CURRENT_POSITION"], relationship: "FLEET", costUnits: 4 },
});

export function authorizeRealtimeSubscription(input: {
  readonly principal: SyntheticPrincipal;
  readonly organizationId: string;
  readonly authorizationGeneration: number;
  readonly purpose: SubscriptionPurpose;
  readonly scope: NormalizedScope;
  readonly usedCostUnits?: number;
  readonly maximumCostUnits?: number;
}): AuthorizedSubscription {
  const rule = RULES[input.purpose];
  if (input.principal.organizationId !== input.organizationId) throw new RealtimeAuthorizationDenied("ORGANIZATION_DENIED");
  if (!input.principal.capabilities.has(rule.capability)) throw new RealtimeAuthorizationDenied("CAPABILITY_DENIED");
  if (!input.principal.purposes.has(rule.domainPurpose)) throw new RealtimeAuthorizationDenied("PURPOSE_DENIED");
  if (input.scope.streamKind !== rule.streamKind) throw new RealtimeAuthorizationDenied("SCOPE_DENIED");
  if (["DISPATCH_DAY", "DRIVER_MANIFEST", "FACILITY_DAY"].includes(input.scope.streamKind) && input.scope.serviceDate === undefined) throw new RealtimeAuthorizationDenied("SCOPE_DENIED");
  if (rule.relationship === "BRANCH" && !input.principal.branchScopes.has(input.scope.scopeReference)) throw new RealtimeAuthorizationDenied("RELATIONSHIP_DENIED");
  if (rule.relationship === "FLEET" && !input.principal.fleetScopes.has(input.scope.scopeReference)) throw new RealtimeAuthorizationDenied("RELATIONSHIP_DENIED");
  if (rule.relationship === "SUBJECT" && (input.scope.subjectReference === undefined || input.scope.subjectReference !== input.principal.subjectId)) throw new RealtimeAuthorizationDenied("RELATIONSHIP_DENIED");
  const used = input.usedCostUnits ?? 0;
  const maximum = input.maximumCostUnits ?? 32;
  if (used + rule.costUnits > maximum) throw new RealtimeAuthorizationDenied("COST_LIMIT");
  return Object.freeze({ organizationId: input.organizationId, principalId: input.principal.id, authorizationGeneration: input.authorizationGeneration,
    purpose: input.purpose, scope: Object.freeze({ ...input.scope }), allowedDeltaKinds: new Set(rule.deltaKinds), costUnits: rule.costUnits });
}

export function assertDeltaAuthorized(authorization: AuthorizedSubscription, deltaKind: string): void {
  if (!authorization.allowedDeltaKinds.has(deltaKind)) throw new RealtimeAuthorizationDenied("PURPOSE_DENIED");
}

export interface AuthorizationGenerationSource {
  current(principalId: string): number;
}

export function createAuthorizationGenerationSource(): AuthorizationGenerationSource & { revoke(principalId: string): number } {
  const generations = new Map<string, number>();
  return Object.freeze({
    current(principalId: string) { return generations.get(principalId) ?? 1; },
    revoke(principalId: string) { const next = (generations.get(principalId) ?? 1) + 1; generations.set(principalId, next); return next; },
  });
}
