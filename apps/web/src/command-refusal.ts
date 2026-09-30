import { DevelopmentApiError } from "@kavaroutes/api-contracts/private-development-transport";

/**
 * The backend names the constraint that refused a dispatch command. Show the
 * operator that name instead of one generic rejection: a missing fleet capacity
 * record and a genuine double-booking need different actions. Every dispatch
 * surface that issues a command (assignment, release, trip cancel) reads the same.
 */
const refusalMessages=new Map<string,string>([
  ["PERSISTENCE_STALE_VERSION","Conflict. Refresh and review the current records before retrying."],
  ["VERSION_CONFLICT","Conflict. Refresh and review the current records before retrying."],
  ["PERSISTENCE_RESOURCE_OVERLAP","The driver or vehicle is already on an overlapping run. Pick another resource, or move this run window."],
  ["PERSISTENCE_FEASIBILITY","The vehicle has no usable capacity record for this run (seats or wheelchair spaces). Fix the fleet record or choose another vehicle."],
  ["PERSISTENCE_QUALIFICATION","The driver or vehicle is missing a qualification this run requires."],
  ["PERSISTENCE_VEHICLE_BLOCKED","The vehicle has an unresolved critical defect from an inspection. Clear the defect before assigning it."],
  ["PERSISTENCE_WORK_STARTED","This run already has started work. Recover the execution instead of reassigning it."],
  ["PERSISTENCE_SHIFT_ACTIVE","The driver holds an active shift that must be resolved before this reassignment."],
  ["PERSISTENCE_LEG_WINDOW","A leg of this run is cancelled or scheduled outside the run window. Correct the run before assigning."],
  ["PERSISTENCE_IDEMPOTENCY_IN_PROGRESS","An earlier dispatch command is still unacknowledged. Open Command recovery, acknowledge that result, then retry the action."],
  ["PERSISTENCE_IDEMPOTENCY_EXPIRED","The original command expired before it was acknowledged. Reload the page, review the current state, then repeat the action."],
  ["PERSISTENCE_IDEMPOTENCY_MISMATCH","That request identity already belongs to a different command. Reload the page before repeating the action."],
  ["PERSISTENCE_RELATIONSHIP","That record no longer exists. Refresh the page and review the current state."],
  ["PERSISTENCE_DUPLICATE","The server already holds this record. Refresh the page and review the current state."],
  ["PERSISTENCE_TENANT","That record is outside this organization's scope. Refresh the page and review the current state."],
]);

export function dispatchCommandRefusal(code: string): string | null {
  return refusalMessages.get(code)??null;
}

/** A refusal message for a dispatch command: the named constraint when the code is
 * known, the raw code with its server reference otherwise. */
export function dispatchCommandMessage(error: unknown, fallback: string): string {
  if (!(error instanceof DevelopmentApiError)) return fallback;
  const named = dispatchCommandRefusal(error.code);
  const reference = error.requestId ? ` (server reference ${error.requestId})` : "";
  return named ? `${named}${reference}` : `${error.code.replaceAll("_", " ")}${reference}`;
}
