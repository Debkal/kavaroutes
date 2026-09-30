export type WebCapability = "DISPATCH_DAY_READ" | "DISPATCH_ASSIGN" | "FACILITY_DAY_READ";
export type PrincipalState = "ACTIVE" | "REVOKED" | "EXPIRED";

export interface SyntheticPrincipal {
  readonly reference: string;
  readonly organizationReference: string;
  readonly facilityReference: string | null;
  readonly capabilities: ReadonlySet<WebCapability>;
  readonly state: PrincipalState;
}

const principal = (value: Omit<SyntheticPrincipal, "capabilities"> & { readonly capabilities: readonly WebCapability[] }): SyntheticPrincipal =>
  Object.freeze({ ...value, capabilities: new Set(value.capabilities) });

export const SYNTHETIC_PRINCIPALS = Object.freeze({
  dispatcherAlpha: principal({ reference: "principal-dispatch-alpha", organizationReference: "organization-synthetic-alpha", facilityReference: null, capabilities: ["DISPATCH_DAY_READ", "DISPATCH_ASSIGN"], state: "ACTIVE" }),
  dispatcherBeta: principal({ reference: "principal-dispatch-beta", organizationReference: "organization-synthetic-alpha", facilityReference: null, capabilities: ["DISPATCH_DAY_READ", "DISPATCH_ASSIGN"], state: "ACTIVE" }),
  facilityAlpha: principal({ reference: "principal-facility-alpha", organizationReference: "organization-synthetic-alpha", facilityReference: "facility-synthetic-alpha", capabilities: ["FACILITY_DAY_READ"], state: "ACTIVE" }),
  wrongFacility: principal({ reference: "principal-facility-beta", organizationReference: "organization-synthetic-alpha", facilityReference: "facility-synthetic-beta", capabilities: ["FACILITY_DAY_READ"], state: "ACTIVE" }),
  expired: principal({ reference: "principal-expired", organizationReference: "organization-synthetic-alpha", facilityReference: null, capabilities: ["DISPATCH_DAY_READ"], state: "EXPIRED" }),
});

export function assertCapability(subject: SyntheticPrincipal, capability: WebCapability): void {
  if (subject.state !== "ACTIVE") throw new Error(subject.state === "EXPIRED" ? "SESSION_EXPIRED" : "SESSION_REVOKED");
  if (!subject.capabilities.has(capability)) throw new Error("CAPABILITY_DENIED");
}

export function assertFacilityScope(subject: SyntheticPrincipal, facilityReference: string): void {
  assertCapability(subject, "FACILITY_DAY_READ");
  if (subject.facilityReference !== facilityReference) throw new Error("FACILITY_SCOPE_DENIED");
}
