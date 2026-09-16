import { Type, type Static } from "typebox";

const id = () => Type.String({ format: "uuid" });
const label = () => Type.String({ minLength: 1, maxLength: 512 });
const serviceControl = Type.Object({
  riderVerified: Type.Boolean(),boardingSecure: Type.Boolean(),safelyUnloaded: Type.Boolean(),incidentOpen: Type.Boolean(),
  pickupEvidenceId: Type.Union([id(),Type.Null()]),dropoffEvidenceId: Type.Union([id(),Type.Null()]),
  proofRule: Type.Union([Type.Null(),Type.Object({ version: Type.Integer({ minimum: 1 }),digest: Type.String({ pattern: "^[a-f0-9]{64}$" }),
    rule: Type.Object({ pickupRequired: Type.Boolean(),dropoffRequired: Type.Boolean(),mobilitySecurementRequired: Type.Boolean(),
      allowedRoles: Type.Array(Type.Union([Type.Literal("RIDER"),Type.Literal("GUARDIAN_OR_AUTHORIZED_REPRESENTATIVE"),Type.Literal("FACILITY_EMPLOYEE"),Type.Literal("DRIVER"),Type.Literal("RIDER_UNABLE_TO_SIGN")]),{ minItems: 1,maxItems: 5 }),
      unableReasons: Type.Array(Type.Union([Type.Literal("DECLINED"),Type.Literal("PHYSICALLY_UNABLE"),Type.Literal("NO_AUTHORIZED_SIGNER")]),{ maxItems: 3 }),
      noShowWaitMinutes: Type.Integer({ minimum: 1,maximum: 120 }),noShowAllowed: Type.Boolean(),noShowAuthorizationReference: Type.Union([id(),Type.Null()]),
    },{ additionalProperties: false }),
  },{ additionalProperties: false })]),
},{ additionalProperties: false });
export const DriverItinerarySchema = Type.Object({
  driverReference: id(), serviceDate: Type.String({ format: "date" }),
  legs: Type.Array(Type.Object({
    assignmentId: id(), assignmentVersion: Type.Integer({ minimum: 1 }),
    runId: id(), runVersion: Type.Integer({ minimum: 1 }), runLifecycle: label(),
    vehicleId: Type.Union([id(), Type.Null()]), vehicleLabel: Type.Union([label(), Type.Null()]),
    tripId: id(), tripLegId: id(), ordinal: Type.Integer({ minimum: 1 }),
    riderLabel: label(), pickupLabel: label(), dropoffLabel: label(),
    plannedStartAt: Type.String({ format: "date-time" }), plannedEndAt: Type.String({ format: "date-time" }), serviceTimezone: label(),
    // Optional during prototype rollout; null means no dispatched execution exists.
    execution: Type.Optional(Type.Union([Type.Null(), Type.Object({
      executionId: id(), lifecycle: Type.String({ pattern: "^[A-Z][A-Z_]{1,63}$", maxLength: 64 }),
      version: Type.Integer({ minimum: 1 }),
      expectedTag: Type.Optional(Type.String({ pattern: '^"kr1\\.[A-Za-z0-9_-]{43}"$' })),
      serviceControl: Type.Optional(serviceControl),
    }, { additionalProperties: false })])),
  }, { additionalProperties: false }), { maxItems: 500 }),
}, { additionalProperties: false, $id: "DriverItinerary", title: "DriverItinerary" });
export type DriverItinerary = Static<typeof DriverItinerarySchema>;
export interface DriverItineraryReader {
  (organizationId: string, driverId: string, serviceDate: string): Promise<readonly DriverItinerary["legs"][number][]>;
}
