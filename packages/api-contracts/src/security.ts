import { ProtocolError } from "./protocol.js";

export const syntheticIds = Object.freeze({
  organizationA: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  organizationB: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  dispatcher: "10000000-0000-4000-8000-000000000001",
  driver: "10000000-0000-4000-8000-000000000002",
  facility: "10000000-0000-4000-8000-000000000003",
  billing: "10000000-0000-4000-8000-000000000004",
  audit: "10000000-0000-4000-8000-000000000005",
  integration: "10000000-0000-4000-8000-000000000006",
  outsider: "20000000-0000-4000-8000-000000000001",
  driverSubject: "30000000-0000-4000-8000-000000000001",
  facilitySubject: "30000000-0000-4000-8000-000000000002",
});

export type Capability =
  | "profile:read" | "riders:read" | "riders:write" | "trips:read" | "trips:write" | "trips:command"
  | "dispatch:read" | "dispatch:command" | "dispatch:location:read" | "fleet:read" | "fleet:command" | "driver:manifest:read"
  | "driver:execute" | "driver:location:write" | "facility:trip-status:read" | "facility:coordinate"
  | "billing:read" | "billing:command" | "integrations:read" | "integrations:write" | "audit:read";
export type Purpose = "RIDER_INTAKE" | "ASSIGNED_SERVICE_DELIVERY" | "FACILITY_COORDINATION" | "BILLING_PROOF" | "SUPPORT_DIAGNOSTICS" | "PARTNER_EXPORT";

export interface SyntheticPrincipal {
  readonly id: string;
  readonly kind: "SYNTHETIC_USER" | "SYNTHETIC_DEVICE";
  readonly organizationId: string;
  readonly capabilities: ReadonlySet<Capability>;
  readonly purposes: ReadonlySet<Purpose>;
  readonly branchScopes: ReadonlySet<string>;
  readonly fleetScopes: ReadonlySet<string>;
  readonly subjectId?: string;
}

const allDispatcherCapabilities: readonly Capability[] = ["profile:read", "riders:read", "riders:write", "trips:read", "trips:write", "trips:command", "dispatch:read", "dispatch:command", "dispatch:location:read", "fleet:read", "fleet:command"];
const fixture = (input: Omit<SyntheticPrincipal, "capabilities" | "purposes" | "branchScopes" | "fleetScopes"> & { capabilities: readonly Capability[]; purposes: readonly Purpose[]; branchScopes?: readonly string[]; fleetScopes?: readonly string[] }): SyntheticPrincipal => Object.freeze({
  ...input,
  capabilities: new Set(input.capabilities), purposes: new Set(input.purposes),
  branchScopes: new Set(input.branchScopes ?? ["branch:synthetic-all"]), fleetScopes: new Set(input.fleetScopes ?? ["fleet:synthetic-all"]),
});

const principals = new Map<string, SyntheticPrincipal>([
  ["principal_dispatcher", fixture({ id: syntheticIds.dispatcher, kind: "SYNTHETIC_USER", organizationId: syntheticIds.organizationA, capabilities: allDispatcherCapabilities, purposes: ["RIDER_INTAKE", "ASSIGNED_SERVICE_DELIVERY"] })],
  ["principal_driver", fixture({ id: syntheticIds.driver, kind: "SYNTHETIC_DEVICE", organizationId: syntheticIds.organizationA, subjectId: syntheticIds.driverSubject, capabilities: ["profile:read", "driver:manifest:read", "driver:execute", "driver:location:write"], purposes: ["ASSIGNED_SERVICE_DELIVERY"] })],
  ["principal_facility", fixture({ id: syntheticIds.facility, kind: "SYNTHETIC_USER", organizationId: syntheticIds.organizationA, subjectId: syntheticIds.facilitySubject, capabilities: ["profile:read", "facility:trip-status:read", "facility:coordinate"], purposes: ["FACILITY_COORDINATION"] })],
  ["principal_billing", fixture({ id: syntheticIds.billing, kind: "SYNTHETIC_USER", organizationId: syntheticIds.organizationA, capabilities: ["profile:read", "billing:read", "billing:command"], purposes: ["BILLING_PROOF"] })],
  ["principal_audit", fixture({ id: syntheticIds.audit, kind: "SYNTHETIC_USER", organizationId: syntheticIds.organizationA, capabilities: ["profile:read", "audit:read"], purposes: ["SUPPORT_DIAGNOSTICS"] })],
  ["principal_integration", fixture({ id: syntheticIds.integration, kind: "SYNTHETIC_USER", organizationId: syntheticIds.organizationA, capabilities: ["profile:read", "integrations:read", "integrations:write"], purposes: ["PARTNER_EXPORT"] })],
  ["principal_outsider", fixture({ id: syntheticIds.outsider, kind: "SYNTHETIC_USER", organizationId: syntheticIds.organizationB, capabilities: allDispatcherCapabilities, purposes: ["RIDER_INTAKE", "ASSIGNED_SERVICE_DELIVERY"] })],
]);

export interface PrincipalVerifier {
  verify(authorization: unknown): Promise<SyntheticPrincipal | null>;
}

export function createSyntheticTestVerifier(): PrincipalVerifier {
  return Object.freeze({
    async verify(authorization: unknown) {
      if (typeof authorization !== "string") return null;
      const match = /^Synthetic (principal_[a-z]+)$/.exec(authorization);
      return match?.[1] ? principals.get(match[1]) ?? null : null;
    },
  });
}

export interface AuthorizationRequirement {
  readonly capability: Capability;
  readonly purpose: Purpose;
  readonly branchScope?: string;
  readonly fleetScope?: string;
  readonly subjectId?: string;
  readonly resourceIsVisible?: boolean;
  readonly relationshipMatches?: boolean;
}

export function authorize(principal: SyntheticPrincipal, organizationId: string, requirement: AuthorizationRequirement): void {
  if (principal.organizationId !== organizationId) throw new ProtocolError(404, "RESOURCE_NOT_FOUND", "resource hidden");
  if (!principal.capabilities.has(requirement.capability) || !principal.purposes.has(requirement.purpose)) {
    throw new ProtocolError(requirement.resourceIsVisible ? 403 : 404, requirement.resourceIsVisible ? "ACTION_FORBIDDEN" : "RESOURCE_NOT_FOUND", "authorization denied");
  }
  if (requirement.branchScope && !principal.branchScopes.has(requirement.branchScope)) throw new ProtocolError(404, "RESOURCE_NOT_FOUND", "resource hidden");
  if (requirement.fleetScope && !principal.fleetScopes.has(requirement.fleetScope)) throw new ProtocolError(404, "RESOURCE_NOT_FOUND", "resource hidden");
  if (requirement.subjectId && principal.subjectId !== requirement.subjectId) throw new ProtocolError(404, "RESOURCE_NOT_FOUND", "resource hidden");
  if (requirement.relationshipMatches === false) throw new ProtocolError(404, "RESOURCE_NOT_FOUND", "resource hidden");
}
