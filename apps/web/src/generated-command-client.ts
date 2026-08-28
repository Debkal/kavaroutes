import { createKavaRoutesClient, GeneratedApiProblem, type FetchLike } from "@kavaroutes/api-contracts/client-web";
import type { AssignmentReceipt, AssignmentRequest } from "./contracts";
import type { SyntheticPrincipal } from "./identity";
import { SyntheticApiProblem, type FailureMode } from "./synthetic-api";

interface SyntheticAssignmentApi {
  assign(principal: SyntheticPrincipal, request: AssignmentRequest, failure: FailureMode): Promise<AssignmentReceipt>;
}

function problemCode(problem: unknown): string {
  return typeof problem === "object" && problem !== null && typeof (problem as { code?: unknown }).code === "string" ? (problem as { code: string }).code : "API_PROBLEM";
}

export function createGeneratedAssignmentClient(api: SyntheticAssignmentApi, principal: SyntheticPrincipal) {
  let failureMode: FailureMode = "NONE";
  const fetcher: FetchLike = async (path, init) => {
    if (!path.endsWith("/commands/reassign-leg") || init?.method !== "POST" || !init.body) return { status: 404, async json() { return { code: "ROUTE_NOT_FOUND" }; } };
    const body = JSON.parse(init.body) as { tripReference?: unknown; driverLabel?: unknown };
    const expectedTag = init.headers?.["if-match"] ?? "";
    const expectedVersion = Number(/^\"v([0-9]+)\"$/.exec(expectedTag)?.[1]);
    const request: AssignmentRequest = { tripReference: String(body.tripReference), driverLabel: String(body.driverLabel), expectedVersion, idempotencyKey: init.headers?.["idempotency-key"] ?? "" };
    try { const receipt = await api.assign(principal, request, failureMode); return { status: 200, async json() { return receipt; } }; }
    catch (error) {
      if (error instanceof SyntheticApiProblem) return { status: error.status, async json() { return { code: error.code }; } };
      throw error;
    }
  };
  const generated = createKavaRoutesClient(fetcher);
  return Object.freeze({
    async assign(request: AssignmentRequest, failure: FailureMode): Promise<AssignmentReceipt> {
      failureMode = failure;
      try {
        const payload = await generated.postCommand(`/v1/synthetic/assignments/${request.tripReference}/commands/reassign-leg`, "Synthetic local dispatcher", { tripReference: request.tripReference, driverLabel: request.driverLabel }, `"v${request.expectedVersion}"`, request.idempotencyKey);
        if (typeof payload !== "object" || payload === null || !["ACCEPTED", "REPLAYED"].includes(String((payload as { outcome?: unknown }).outcome))) throw new Error("INVALID_ASSIGNMENT_RECEIPT");
        return payload as AssignmentReceipt;
      } catch (error) {
        if (error instanceof GeneratedApiProblem) throw new SyntheticApiProblem(error.status, problemCode(error.problem));
        throw error;
      }
    },
  });
}
