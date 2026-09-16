/** Driver itinerary reader for the reviewed `guarded-live` profile.
 *
 * The persisted read model selects the stored proof rule as raw `jsonb`, while
 * the public itinerary contract types that rule structurally. This adapter
 * re-validates every stored rule with the same `validateProofRule` used by the
 * signature write path and rebuilds it as the wire shape, so an unrecognized
 * stored rule fails the request instead of being silently dropped by response
 * serialization. The private synthetic runtime keeps its own reader
 * (`infra/gcp/runtime/api.mjs`) and is not routed through this adapter.
 */
import { validateProofRule, type DriverItinerary, type DriverItineraryReader } from '@kavaroutes/api-contracts';
import { createDriverItineraryReader, type StoredDriverItineraryLeg, type StoredDriverServiceControl } from '@kavaroutes/postgres-persistence';

type DatabasePool = Parameters<typeof createDriverItineraryReader>[0];
type WireLeg = DriverItinerary['legs'][number];
type WireExecution = NonNullable<WireLeg['execution']>;
type WireServiceControl = NonNullable<WireExecution['serviceControl']>;
type WireProofRule = NonNullable<WireServiceControl['proofRule']>;
type WireStructuredRule = WireProofRule['rule'];

const signerRoles = ['RIDER', 'GUARDIAN_OR_AUTHORIZED_REPRESENTATIVE', 'FACILITY_EMPLOYEE', 'DRIVER', 'RIDER_UNABLE_TO_SIGN'] as const;
const unableReasons = ['DECLINED', 'PHYSICALLY_UNABLE', 'NO_AUTHORIZED_SIGNER'] as const;

function invalid(): never {
  throw new Error('PROOF_POLICY_STORAGE_INVALID');
}

/** Rebuild the stored rule as the closed wire shape. Membership is re-checked
 * per element, so a stored role or reason outside the contract is refused
 * rather than narrowed by assertion. */
function structuredRule(value: unknown): WireStructuredRule {
  const rule = validateProofRule(value);
  return { pickupRequired: rule.pickupRequired, dropoffRequired: rule.dropoffRequired,
    mobilitySecurementRequired: rule.mobilitySecurementRequired,
    allowedRoles: rule.allowedRoles.map(role => signerRoles.find(candidate => candidate === role) ?? invalid()),
    unableReasons: rule.unableReasons.map(reason => unableReasons.find(candidate => candidate === reason) ?? invalid()),
    noShowWaitMinutes: rule.noShowWaitMinutes, noShowAllowed: rule.noShowAllowed,
    noShowAuthorizationReference: rule.noShowAuthorizationReference };
}

function storedProofRule(rule: StoredDriverServiceControl['proofRule']): WireProofRule | null {
  return rule === null ? null : { version: rule.version, digest: rule.digest, rule: structuredRule(rule.rule) };
}

function storedServiceControl(control: StoredDriverServiceControl): WireServiceControl {
  return { riderVerified: control.riderVerified, boardingSecure: control.boardingSecure, safelyUnloaded: control.safelyUnloaded,
    incidentOpen: control.incidentOpen, pickupEvidenceId: control.pickupEvidenceId, dropoffEvidenceId: control.dropoffEvidenceId,
    proofRule: storedProofRule(control.proofRule) };
}

function storedExecution(value: NonNullable<StoredDriverItineraryLeg['execution']>): WireExecution {
  return { executionId: value.executionId, lifecycle: value.lifecycle, version: value.version,
    ...(value.serviceControl ? { serviceControl: storedServiceControl(value.serviceControl) } : {}) };
}

/** Pure mapping from the persisted read model to the public itinerary leg. */
export function toWireItineraryLeg(leg: StoredDriverItineraryLeg): WireLeg {
  const { execution, ...rest } = leg;
  return { ...rest, execution: execution ? storedExecution(execution) : null };
}

export function createGuardedDriverItineraryReader(pool: DatabasePool): DriverItineraryReader {
  const read = createDriverItineraryReader(pool);
  return async (organizationId, driverId, serviceDate) => (await read(organizationId, driverId, serviceDate)).map(toWireItineraryLeg);
}
