import type { AssignmentReceipt, AssignmentRequest, BoardProjection } from "./contracts";
import { assertCapability, assertFacilityScope, type SyntheticPrincipal } from "./identity";

export type FailureMode = "NONE" | "LOST_RESPONSE" | "LATE_RESPONSE" | "CONFLICT" | "CONFLICT_409" | "FORBIDDEN" | "UNAUTHORIZED" | "INVALID" | "RATE_LIMITED" | "SERVER_ERROR";
export class SyntheticApiProblem extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}

export function createSyntheticApi(initial: BoardProjection) {
  let projection = initial;
  const receipts = new Map<string, AssignmentReceipt>();
  return Object.freeze({
    async getDispatchDay(principal: SyntheticPrincipal, signal?: AbortSignal): Promise<BoardProjection> {
      assertCapability(principal, "DISPATCH_DAY_READ");
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      return projection;
    },
    async getFacilityDay(principal: SyntheticPrincipal, facilityReference: string, signal?: AbortSignal): Promise<BoardProjection> {
      assertFacilityScope(principal, facilityReference);
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      return Object.freeze({ ...projection, positions: Object.freeze([]), trips: Object.freeze(projection.trips.filter((trip) => trip.facilityReference === facilityReference).map((trip) => Object.freeze({ ...trip, driverLabel: null, vehicleLabel: null }))) });
    },
    async assign(principal: SyntheticPrincipal, request: AssignmentRequest, failure: FailureMode = "NONE"): Promise<AssignmentReceipt> {
      assertCapability(principal, "DISPATCH_ASSIGN");
      const prior = receipts.get(request.idempotencyKey);
      if (prior) return Object.freeze({ ...prior, outcome: "REPLAYED" });
      if (failure === "UNAUTHORIZED") throw new SyntheticApiProblem(401, "SESSION_EXPIRED");
      if (failure === "FORBIDDEN") throw new SyntheticApiProblem(403, "CAPABILITY_DENIED");
      if (failure === "CONFLICT") throw new SyntheticApiProblem(412, "VERSION_CONFLICT");
      if (failure === "CONFLICT_409") throw new SyntheticApiProblem(409, "ASSIGNMENT_CONFLICT");
      if (failure === "INVALID") throw new SyntheticApiProblem(422, "ASSIGNMENT_INVALID");
      if (failure === "RATE_LIMITED") throw new SyntheticApiProblem(429, "RATE_LIMITED");
      if (failure === "SERVER_ERROR") throw new SyntheticApiProblem(503, "SERVICE_UNAVAILABLE");
      const trip = projection.trips.find((candidate) => candidate.reference === request.tripReference);
      if (!trip) throw new SyntheticApiProblem(404, "TRIP_NOT_FOUND");
      if (trip.version !== request.expectedVersion) throw new SyntheticApiProblem(412, "VERSION_CONFLICT");
      const receipt = Object.freeze({ outcome: "ACCEPTED", tripReference: trip.reference, nextVersion: trip.version + 1 } satisfies AssignmentReceipt);
      receipts.set(request.idempotencyKey, receipt);
      projection = Object.freeze({ ...projection, version: projection.version + 1, trips: Object.freeze(projection.trips.map((candidate) => candidate.reference === trip.reference ? Object.freeze({ ...candidate, driverLabel: request.driverLabel, vehicleLabel: request.driverLabel.replace("Driver", "Vehicle"), version: receipt.nextVersion }) : candidate)) });
      if (failure === "LOST_RESPONSE") throw new SyntheticApiProblem(0, "OUTCOME_UNKNOWN");
      if (failure === "LATE_RESPONSE") await new Promise((resolve) => setTimeout(resolve, 50));
      return receipt;
    },
    snapshot: () => projection,
  });
}
