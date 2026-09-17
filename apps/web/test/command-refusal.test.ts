import { describe, expect, it } from "vitest";
import { DevelopmentApiError } from "@kavaroutes/api-contracts/private-development-transport";
import { dispatchCommandMessage, dispatchCommandRefusal } from "../src/command-refusal";

describe("dispatch command refusal copy", () => {
  it("names the unacknowledged-command block and quotes the server reference", () => {
    const message = dispatchCommandMessage(new DevelopmentApiError(409, "PERSISTENCE_IDEMPOTENCY_IN_PROGRESS", "req_wp007_00001007"), "Request unavailable.");
    expect(message).toBe("An earlier dispatch command is still unacknowledged. Open Command recovery, acknowledge that result, then retry the action. (server reference req_wp007_00001007)");
  });

  it("names the dispatch constraints the backend reports", () => {
    expect(dispatchCommandRefusal("PERSISTENCE_RESOURCE_OVERLAP")).toMatch(/overlapping run/);
    expect(dispatchCommandRefusal("PERSISTENCE_VEHICLE_BLOCKED")).toMatch(/critical defect/);
    expect(dispatchCommandRefusal("PERSISTENCE_STALE_VERSION")).toMatch(/Refresh and review/);
    expect(dispatchCommandRefusal("VERSION_CONFLICT")).not.toBeNull();
  });

  it("falls back to the raw code with its reference, then to the caller's copy", () => {
    expect(dispatchCommandMessage(new DevelopmentApiError(502, "TRANSPORT_UNAVAILABLE", "req_wp007_00000009"), "Request unavailable."))
      .toBe("TRANSPORT UNAVAILABLE (server reference req_wp007_00000009)");
    expect(dispatchCommandMessage(new Error("boom"), "Request unavailable.")).toBe("Request unavailable.");
    expect(dispatchCommandRefusal("PERSISTENCE_SOMETHING_NEW")).toBeNull();
  });
});
