import { createHash } from "node:crypto";

export const COMMERCIAL_TIERS = ["SMALL_BUSINESS", "ENTERPRISE"] as const;
export const WORKFORCE_RELATIONSHIPS = ["OWNER_OPERATOR", "EMPLOYEE", "CONTRACTOR"] as const;
export const INSPECTION_CONTROL_MODES = ["DISABLED", "OPTIONAL", "REQUIRED"] as const;
export const RETURN_VERIFICATION_MODES = ["DISABLED", "ADVISORY", "REQUIRED_WITH_AUDITED_OVERRIDE"] as const;
export const ROUTE_CHANGE_MODES = ["AUTHORIZED_SELF_APPROVE", "DISPATCH_APPROVAL_REQUIRED", "DISABLED"] as const;

export type CommercialTier = typeof COMMERCIAL_TIERS[number];
export type WorkforceRelationship = typeof WORKFORCE_RELATIONSHIPS[number];
export type InspectionControlMode = typeof INSPECTION_CONTROL_MODES[number];
export type ReturnVerificationMode = typeof RETURN_VERIFICATION_MODES[number];
export type RouteChangeMode = typeof ROUTE_CHANGE_MODES[number];
export type DriverControlSource = "EXTERNAL_FLOOR" | "ORGANIZATION_LOCK" | "ORGANIZATION_CONFIGURATION" | "WORKFORCE_PRESET" | "TIER_DEFAULT";
export type DriverControlReasonCode =
  | "EXTERNAL_REQUIREMENT_APPLIED" | "ORGANIZATION_LOCK_APPLIED" | "ORGANIZATION_CONFIGURATION_APPLIED"
  | "SMALL_BUSINESS_OWNER_DEFAULT" | "SMALL_BUSINESS_WORKFORCE_PRESET" | "ENTERPRISE_STRICT_DEFAULT"
  | "SELF_APPROVAL_CAPABILITY_MISSING";

export interface ScopedControl<TMode extends string> {
  readonly mode: TMode;
  readonly locked?: boolean;
}

export interface DriverControlSet {
  readonly preInspection?: ScopedControl<InspectionControlMode>;
  readonly postInspection?: ScopedControl<InspectionControlMode>;
  readonly startOdometer?: ScopedControl<InspectionControlMode>;
  readonly endOdometer?: ScopedControl<InspectionControlMode>;
  readonly returnVerification?: ScopedControl<ReturnVerificationMode>;
  readonly routeChange?: ScopedControl<RouteChangeMode>;
}

export interface EffectiveControl<TMode extends string> {
  readonly mode: TMode;
  readonly source: DriverControlSource;
  readonly reasonCode: DriverControlReasonCode;
  readonly locked: boolean;
}

export interface EffectiveDriverPolicy {
  readonly schemaVersion: 1;
  readonly organizationId: string;
  readonly driverId: string;
  readonly assignmentId: string;
  readonly commercialTier: CommercialTier;
  readonly workforceRelationship: WorkforceRelationship;
  readonly policyVersion: number;
  readonly resolvedAt: string;
  readonly preInspection: EffectiveControl<InspectionControlMode>;
  readonly postInspection: EffectiveControl<InspectionControlMode>;
  readonly startOdometer: EffectiveControl<InspectionControlMode>;
  readonly endOdometer: EffectiveControl<InspectionControlMode>;
  readonly returnVerification: EffectiveControl<ReturnVerificationMode>;
  readonly routeChange: EffectiveControl<RouteChangeMode>;
  readonly proofOfServicePolicy: "PAYER_CONTRACT_ORGANIZATION_RESOLVED";
  readonly nonWaivableControls: readonly ["IDENTITY_AND_AUTHORIZATION", "TENANT_ISOLATION", "ENCRYPTION_AND_AUDIT", "MINIMUM_NECESSARY", "NO_PHI_NAVIGATION", "TRACKING_TRANSPARENCY", "EMERGENCY_STOP"];
  readonly canonicalDigest: string;
}

export interface ResolveEffectiveDriverPolicyInput {
  readonly organizationId: string;
  readonly driverId: string;
  readonly assignmentId: string;
  readonly commercialTier: CommercialTier;
  readonly workforceRelationship: WorkforceRelationship;
  readonly policyVersion: number;
  readonly resolvedAt: string;
  readonly organization?: DriverControlSet;
  readonly externalFloor?: DriverControlSet;
  readonly capabilities: ReadonlySet<"driver-route:self-approve" | "driver-policy:override">;
}

type ControlKey = keyof DriverControlSet;
const inspectionRank: Readonly<Record<InspectionControlMode, number>> = { DISABLED: 0, OPTIONAL: 1, REQUIRED: 2 };
const returnRank: Readonly<Record<ReturnVerificationMode, number>> = { DISABLED: 0, ADVISORY: 1, REQUIRED_WITH_AUDITED_OVERRIDE: 2 };
const routeRank: Readonly<Record<RouteChangeMode, number>> = { AUTHORIZED_SELF_APPROVE: 0, DISPATCH_APPROVAL_REQUIRED: 1, DISABLED: 2 };

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value);
}

function strictest<TMode extends string>(values: readonly ScopedControl<TMode>[], rank: Readonly<Record<TMode, number>>): ScopedControl<TMode> | undefined {
  return values.reduce<ScopedControl<TMode> | undefined>((selected, candidate) => !selected || rank[candidate.mode] > rank[selected.mode] ? candidate : selected, undefined);
}

function tierDefaults(tier: CommercialTier, relationship: WorkforceRelationship, selfApprove: boolean): Required<Record<ControlKey, string>> {
  if (tier === "ENTERPRISE") return {
    preInspection: "REQUIRED", postInspection: "REQUIRED", startOdometer: "REQUIRED", endOdometer: "REQUIRED",
    returnVerification: "REQUIRED_WITH_AUDITED_OVERRIDE", routeChange: "DISPATCH_APPROVAL_REQUIRED",
  };
  if (relationship !== "OWNER_OPERATOR") return {
    preInspection: "REQUIRED", postInspection: "REQUIRED", startOdometer: "REQUIRED", endOdometer: "REQUIRED",
    returnVerification: "REQUIRED_WITH_AUDITED_OVERRIDE", routeChange: "DISPATCH_APPROVAL_REQUIRED",
  };
  return {
    preInspection: "OPTIONAL", postInspection: "OPTIONAL", startOdometer: "OPTIONAL", endOdometer: "OPTIONAL",
    returnVerification: "ADVISORY", routeChange: selfApprove ? "AUTHORIZED_SELF_APPROVE" : "DISPATCH_APPROVAL_REQUIRED",
  };
}

function defaultReason(tier: CommercialTier, relationship: WorkforceRelationship): DriverControlReasonCode {
  if (tier === "ENTERPRISE") return "ENTERPRISE_STRICT_DEFAULT";
  return relationship === "OWNER_OPERATOR" ? "SMALL_BUSINESS_OWNER_DEFAULT" : "SMALL_BUSINESS_WORKFORCE_PRESET";
}

function resolveControl<TMode extends string>(input: ResolveEffectiveDriverPolicyInput, key: ControlKey, fallback: TMode, rank: Readonly<Record<TMode, number>>): EffectiveControl<TMode> {
  const external = input.externalFloor?.[key] as ScopedControl<TMode> | undefined;
  const organization = input.organization?.[key] as ScopedControl<TMode> | undefined;
  const locked = strictest([external, organization?.locked ? organization : undefined].filter((value): value is ScopedControl<TMode> => Boolean(value)), rank);
  if (locked) return Object.freeze({
    mode: locked.mode,
    source: external && locked.mode === external.mode ? "EXTERNAL_FLOOR" : "ORGANIZATION_LOCK",
    reasonCode: external && locked.mode === external.mode ? "EXTERNAL_REQUIREMENT_APPLIED" : "ORGANIZATION_LOCK_APPLIED",
    locked: true,
  });
  if (organization) return Object.freeze({ mode: organization.mode, source: "ORGANIZATION_CONFIGURATION", reasonCode: "ORGANIZATION_CONFIGURATION_APPLIED", locked: false });
  return Object.freeze({ mode: fallback, source: input.commercialTier === "SMALL_BUSINESS" && input.workforceRelationship !== "OWNER_OPERATOR" ? "WORKFORCE_PRESET" : "TIER_DEFAULT", reasonCode: defaultReason(input.commercialTier, input.workforceRelationship), locked: input.commercialTier === "ENTERPRISE" });
}

export function resolveEffectiveDriverPolicy(input: ResolveEffectiveDriverPolicyInput): EffectiveDriverPolicy {
  if (!COMMERCIAL_TIERS.includes(input.commercialTier) || !WORKFORCE_RELATIONSHIPS.includes(input.workforceRelationship)) throw new Error("DRIVER_POLICY_CONTEXT_INVALID");
  if (!Number.isInteger(input.policyVersion) || input.policyVersion < 1 || !Number.isFinite(Date.parse(input.resolvedAt))) throw new Error("DRIVER_POLICY_VERSION_INVALID");
  const selfApprove = input.capabilities.has("driver-route:self-approve");
  const defaults = tierDefaults(input.commercialTier, input.workforceRelationship, selfApprove);
  let routeChange = resolveControl(input, "routeChange", defaults.routeChange as RouteChangeMode, routeRank);
  if (routeChange.mode === "AUTHORIZED_SELF_APPROVE" && !selfApprove) routeChange = Object.freeze({ mode: "DISPATCH_APPROVAL_REQUIRED", source: routeChange.source, reasonCode: "SELF_APPROVAL_CAPABILITY_MISSING", locked: routeChange.locked });
  else if (!selfApprove && input.commercialTier === "SMALL_BUSINESS" && input.workforceRelationship === "OWNER_OPERATOR"
    && !input.organization?.routeChange && !input.externalFloor?.routeChange) {
    routeChange = Object.freeze({ ...routeChange, reasonCode: "SELF_APPROVAL_CAPABILITY_MISSING" });
  }
  const unsigned = {
    schemaVersion: 1 as const,
    organizationId: input.organizationId, driverId: input.driverId, assignmentId: input.assignmentId,
    commercialTier: input.commercialTier, workforceRelationship: input.workforceRelationship,
    policyVersion: input.policyVersion, resolvedAt: input.resolvedAt,
    preInspection: resolveControl(input, "preInspection", defaults.preInspection as InspectionControlMode, inspectionRank),
    postInspection: resolveControl(input, "postInspection", defaults.postInspection as InspectionControlMode, inspectionRank),
    startOdometer: resolveControl(input, "startOdometer", defaults.startOdometer as InspectionControlMode, inspectionRank),
    endOdometer: resolveControl(input, "endOdometer", defaults.endOdometer as InspectionControlMode, inspectionRank),
    returnVerification: resolveControl(input, "returnVerification", defaults.returnVerification as ReturnVerificationMode, returnRank),
    routeChange,
    proofOfServicePolicy: "PAYER_CONTRACT_ORGANIZATION_RESOLVED" as const,
    nonWaivableControls: ["IDENTITY_AND_AUTHORIZATION", "TENANT_ISOLATION", "ENCRYPTION_AND_AUDIT", "MINIMUM_NECESSARY", "NO_PHI_NAVIGATION", "TRACKING_TRANSPARENCY", "EMERGENCY_STOP"] as const,
  };
  return Object.freeze({ ...unsigned, canonicalDigest: createHash("sha256").update(canonical(unsigned)).digest("hex") });
}
