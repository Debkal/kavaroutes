import { DevelopmentApiError } from "@kavaroutes/api-contracts/private-development-transport";

/**
 * The backend names the constraint that refused a dispatch command. Show the
 * operator that name instead of one generic rejection: a missing fleet capacity
 * record and a genuine double-booking need different actions. Every dispatch
 * surface that issues a command (assignment, release, trip cancel) reads the same.
 */
export function dispatchCommandRefusal(code: string): string | null {
  switch (code) {
    case "PERSISTENCE_STALE_VERSION": case "VERSION_CONFLICT":
      return "Conflict. Refresh and review the current records before retrying.";
    case "PERSISTENCE_RESOURCE_OVERLAP":
      return "The driver or vehicle is already on an overlapping run. Pick another resource, or move this run window.";
    case "PERSISTENCE_FEASIBILITY":
      return "The vehicle has no usable capacity record for this run (seats or wheelchair spaces). Fix the fleet record or choose another vehicle.";
    case "PERSISTENCE_QUALIFICATION":
      return "The driver or vehicle is missing a qualification this run requires.";
    case "PERSISTENCE_VEHICLE_BLOCKED":
      return "The vehicle has an unresolved critical defect from an inspection. Clear the defect before assigning it.";
    case "PERSISTENCE_WORK_STARTED":
      return "This run already has started work. Recover the execution instead of reassigning it.";
    case "PERSISTENCE_SHIFT_ACTIVE":
      return "The driver holds an active shift that must be resolved before this reassignment.";
    case "PERSISTENCE_LEG_WINDOW":
      return "A leg of this run is cancelled or scheduled outside the run window. Correct the run before assigning.";
    case "PERSISTENCE_IDEMPOTENCY_IN_PROGRESS":
      return "An earlier dispatch command is still unacknowledged. Open Command recovery, acknowledge that result, then retry the action.";
    case "PERSISTENCE_IDEMPOTENCY_EXPIRED":
      return "The original command expired before it was acknowledged. Reload the page, review the current state, then repeat the action.";
    case "PERSISTENCE_IDEMPOTENCY_MISMATCH":
      return "That request identity already belongs to a different command. Reload the page before repeating the action.";
    case "PERSISTENCE_RELATIONSHIP":
      return "That record no longer exists. Refresh the page and review the current state.";
    case "PERSISTENCE_DUPLICATE":
      return "The server already holds this record. Refresh the page and review the current state.";
    case "PERSISTENCE_TENANT":
      return "That record is outside this organization's scope. Refresh the page and review the current state.";
    default:
      return null;
  }
}

/** A refusal message for a dispatch command: the named constraint when the code is
 * known, the raw code with its server reference otherwise. */
export function dispatchCommandMessage(error: unknown, fallback: string): string {
  if (!(error instanceof DevelopmentApiError)) return fallback;
  const named = dispatchCommandRefusal(error.code);
  const reference = error.requestId ? ` (server reference ${error.requestId})` : "";
  return named ? `${named}${reference}` : `${error.code.replaceAll("_", " ")}${reference}`;
}
