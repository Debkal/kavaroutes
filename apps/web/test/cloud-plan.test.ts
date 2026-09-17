import { describe, expect, it } from "vitest";
import { createCloudApi } from "../src/cloud-api";
import { decodeCloudPlanReceipt, type CloudPlanRequest } from "../src/cloud-board-contract";
import { resolveLocalServiceStart } from "../src/cloud-service-time";
import type { DevelopmentFetch } from "@kavaroutes/api-contracts/private-development-transport";

const response = (body: unknown, status = 201) => ({ status, headers: { get: (name: string) => name === "etag" ? '"kr1.' + "A".repeat(43) + '"' : null }, json: async () => body });
const request: CloudPlanRequest = {
  serviceDate: "2026-09-17", serviceTimezone: "America/Los_Angeles",
  plannedStartAt: "2026-09-17T15:45:00.000Z", plannedEndAt: "2026-09-17T16:45:00.000Z",
  seatsRequired: 1, wheelchairSpacesRequired: 0,
  legs: [{
    riderReference: "Synthetic Rider", pickupLabel: "Synthetic Community Center", dropoffLabel: "Synthetic Public Library",
    localServiceTime: "09:00:00", resolvedServiceAt: "2026-09-17T16:00:00.000Z", resolvedUtcOffsetSeconds: -25200,
    plannedStartAt: "2026-09-17T16:00:00.000Z", plannedEndAt: "2026-09-17T16:45:00.000Z", appointmentLengthMinutes:60,
    pickupRequired: true, dropoffRequired: true, mobilitySecurementRequired: false, recordClientDropoff: false,
  }],
};
const receipt = { runId: "10000000-0000-4000-8000-000000000020", version: 1, serviceDate: "2026-09-17", legCount: 1, tripLegIds: ["10000000-0000-4000-8000-000000000021"] };

describe("dispatch route entry", () => {
  it("resolves one local service reading against the reported offset", () => {
    expect(resolveLocalServiceStart("2026-09-17", "09:00", "UTC")).toEqual({instant:"2026-09-17T09:00:00.000Z",offsetSeconds:0});
    expect(()=>resolveLocalServiceStart("2026-03-08","02:30","America/Los_Angeles")).toThrow(/daylight saving/);
    expect(()=>resolveLocalServiceStart("2026-11-01","01:30","America/Los_Angeles")).toThrow(/daylight saving/);
    expect(resolveLocalServiceStart("2026-09-17", "09:00", "America/Los_Angeles")).toEqual({ instant: "2026-09-17T16:00:00.000Z", offsetSeconds: -25200 });
    expect(() => resolveLocalServiceStart("2026-09-17", "09:00", "Not/AZone")).toThrow("SERVICE_TIMEZONE_UNAVAILABLE");
    expect(() => resolveLocalServiceStart("2026-09-17", "9am", "America/Los_Angeles")).toThrow("INVALID_LOCAL_SERVICE_TIME");
  });
  it("posts the dispatch-authored run and accepts only a receipt for that request", async () => {
    let seen: Record<string, unknown> | null = null;
    const fetcher: DevelopmentFetch = async (url, init) => {
      expect(url).toBe("http://127.0.0.1:4311/v1/organizations/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/dispatch/runs/commands/plan");
      expect(init.method).toBe("POST");
      expect(init.headers["idempotency-key"]).toBe("stable-plan-key");
      seen = JSON.parse(init.body!) as Record<string, unknown>;
      return response(receipt);
    };
    const result = await createCloudApi("http://127.0.0.1:4311", fetcher).planRun(request, "stable-plan-key");
    expect(result.value).toEqual(receipt);
    expect(seen).toEqual({ ...request });
  });
  it("refuses a receipt that describes a different run than the one requested", async () => {
    const api = createCloudApi("http://127.0.0.1:4311", async () => response({ ...receipt, legCount: 2 }));
    // A command response that does not decode proves nothing about the commit.
    await expect(api.planRun(request, "stable-plan-key")).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN" });
    expect(() => decodeCloudPlanReceipt({ ...receipt, runId: "not-a-run" }, request)).toThrow("INVALID_BOARD_ID");
  });
  it("reports an unknown outcome instead of planning a replacement run", async () => {
    const api = createCloudApi("http://127.0.0.1:4311", async () => { throw new Error("socket closed"); });
    await expect(api.planRun(request, "stable-plan-key")).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN" });
  });
});
