import { createHash } from "node:crypto";
import { resolveEffectiveDriverPolicy, type CommercialTier, type DriverControlSet, type EffectiveDriverPolicy, type WorkforceRelationship } from "@kavaroutes/platform-engine/domain";
import type { DriverControlPolicy, UpdateDriverControlPolicy } from "./schemas.js";
import type { SyntheticPrincipal } from "./security.js";
import { ProtocolError, requestFingerprint } from "./protocol.js";

export interface DriverPolicyEvent {
  readonly type: "driver.policy.updated" | "driver.shift.policy_snapshotted";
  readonly organizationId: string;
  readonly policyVersion: number;
  readonly policyDigest?: string;
}

export interface DriverPolicyService {
  read(organizationId: string): DriverControlPolicy | null;
  update(input: { organizationId: string; principal: SyntheticPrincipal; idempotencyKey: string; expectedVersion: number | (() => number); command: UpdateDriverControlPolicy }): { policy: DriverControlPolicy; replayed: boolean };
  resolveShift(input: { organizationId: string; driverId: string; assignmentId: string; relationship: WorkforceRelationship; capabilities: ReadonlySet<"driver-route:self-approve" | "driver-policy:override"> }): EffectiveDriverPolicy;
  events(): readonly DriverPolicyEvent[];
}

const strictControls = Object.freeze({
  preInspection: { mode: "REQUIRED", locked: true }, postInspection: { mode: "REQUIRED", locked: true },
  startOdometer: { mode: "REQUIRED", locked: true }, endOdometer: { mode: "REQUIRED", locked: true },
  returnVerification: { mode: "REQUIRED_WITH_AUDITED_OVERRIDE", locked: true }, routeChange: { mode: "DISPATCH_APPROVAL_REQUIRED", locked: true },
} as const);

function toResolverControls(policy: DriverControlPolicy): DriverControlSet {
  return policy.controls as DriverControlSet;
}

function changedLockedControl(current: DriverControlPolicy, command: UpdateDriverControlPolicy): boolean {
  return Object.entries(current.controls).some(([key, value]) => value.locked && JSON.stringify(value) !== JSON.stringify(command.controls[key as keyof typeof command.controls]));
}

export function createSyntheticDriverPolicyService(options: {
  readonly organizationId: string;
  readonly now?: () => Date;
  readonly initialTier?: CommercialTier;
  readonly initialRelationship?: WorkforceRelationship;
}): DriverPolicyService {
  const now = options.now ?? (() => new Date());
  let relationship = options.initialRelationship ?? "EMPLOYEE";
  let policy: DriverControlPolicy = Object.freeze({
    organizationId: options.organizationId, commercialTier: options.initialTier ?? "ENTERPRISE", version: 1, controls: strictControls,
  });
  const eventLog: DriverPolicyEvent[] = [];
  const replay = new Map<string, { fingerprint: string; policy: DriverControlPolicy }>();
  return Object.freeze({
    read(organizationId: string) { return organizationId === policy.organizationId ? policy : null; },
    update({ organizationId, principal, idempotencyKey, expectedVersion, command }: { organizationId: string; principal: SyntheticPrincipal; idempotencyKey: string; expectedVersion: number | (() => number); command: UpdateDriverControlPolicy }) {
      if (organizationId !== policy.organizationId) throw new ProtocolError(404, "RESOURCE_NOT_FOUND", "resource hidden");
      const key = `${organizationId}:${principal.id}:${idempotencyKey}`; const fingerprint = requestFingerprint(command); const prior = replay.get(key);
      if (prior) {
        if (prior.fingerprint !== fingerprint) throw new ProtocolError(422, "IDEMPOTENCY_KEY_REUSED", "idempotency fingerprint differs");
        return { policy: prior.policy, replayed: true };
      }
      const resolvedExpectedVersion = typeof expectedVersion === "function" ? expectedVersion() : expectedVersion;
      if (resolvedExpectedVersion !== policy.version) throw new ProtocolError(412, "PRECONDITION_FAILED", "stale policy version");
      if (changedLockedControl(policy, command)) {
        if (!principal.capabilities.has("driver-policy:override")) throw new ProtocolError(403, "POLICY_OVERRIDE_CAPABILITY_REQUIRED", "separate override capability required");
        if (!command.secondApprovalReference || command.secondApprovalReference === principal.id) throw new ProtocolError(422, "SECOND_APPROVAL_REQUIRED", "distinct second approval required");
      }
      policy = Object.freeze({ organizationId, commercialTier: policy.commercialTier, version: policy.version + 1, controls: command.controls });
      replay.set(key, { fingerprint, policy }); eventLog.push({ type: "driver.policy.updated", organizationId, policyVersion: policy.version });
      return { policy, replayed: false };
    },
    resolveShift({ organizationId, driverId, assignmentId, relationship: requestedRelationship, capabilities }: { organizationId: string; driverId: string; assignmentId: string; relationship: WorkforceRelationship; capabilities: ReadonlySet<"driver-route:self-approve" | "driver-policy:override"> }) {
      if (organizationId !== policy.organizationId) throw new ProtocolError(404, "RESOURCE_NOT_FOUND", "resource hidden");
      relationship = requestedRelationship;
      const result = resolveEffectiveDriverPolicy({ organizationId, driverId, assignmentId, commercialTier: policy.commercialTier,
        workforceRelationship: relationship, policyVersion: policy.version, resolvedAt: now().toISOString(), organization: toResolverControls(policy), capabilities });
      eventLog.push({ type: "driver.shift.policy_snapshotted", organizationId, policyVersion: policy.version, policyDigest: result.canonicalDigest });
      return result;
    },
    events: () => Object.freeze(eventLog.map((event) => Object.freeze({ ...event }))),
  });
}

export function policyVersionFromEtag(value: string, policy: DriverControlPolicy, etagFor: (resourceId: string, version: number, projection: string) => string): number {
  const expected = etagFor(policy.organizationId, policy.version, "driver-control-policy-v1");
  if (value !== expected) throw new ProtocolError(412, "PRECONDITION_FAILED", "stale policy tag");
  return policy.version;
}

export function stablePolicyCommandReference(command: UpdateDriverControlPolicy): string {
  return createHash("sha256").update(requestFingerprint(command)).digest("hex");
}
