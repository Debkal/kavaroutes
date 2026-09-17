import { describe, expect, it, vi } from "vitest";
import { createCloudDriverWebApi, decodeDriverItinerary, driverOrganizationId } from "../src/cloud-driver-api";
import type { DevelopmentFetch } from "@kavaroutes/api-contracts/private-development-transport";

const headers = { get: () => null };
const response = (body: unknown, status = 200) => ({ status, headers, json: async () => body });
const leg = {
  assignmentId: "42000000-0000-4000-8000-000000000001", assignmentVersion: 1,
  runId: "42000000-0000-4000-8000-000000000002", runVersion: 1, runLifecycle: "DISPATCHED",
  vehicleId: "42000000-0000-4000-8000-000000000003", vehicleLabel: "Synthetic Van",
  tripId: "42000000-0000-4000-8000-000000000004", tripLegId: "42000000-0000-4000-8000-000000000005", ordinal: 1,
  riderLabel: "Synthetic rider", pickupLabel: "Synthetic pickup", dropoffLabel: "Synthetic drop-off",
  plannedStartAt: "2026-09-14T15:00:00.000Z", plannedEndAt: "2026-09-14T16:00:00.000Z", serviceTimezone: "America/Los_Angeles",
};

describe("Driver web cloud adapter", () => {
  it("accepts only the authenticated Driver itinerary projection", () => {
    const value = decodeDriverItinerary({ driverReference: "30000000-0000-4000-8000-000000000001", serviceDate: "2026-09-14", legs: [leg] });
    expect(value.legs[0]?.tripLegId).toBe(leg.tripLegId);
    expect(() => decodeDriverItinerary({ driverReference: "40000000-0000-4000-8000-000000000001", serviceDate: "2026-09-14", legs: [leg] })).toThrow("INVALID_DRIVER_ITINERARY");
  });

  it("uses the Driver persona and same-origin Cloudflare session for HTTPS", async () => {
    const fetcher = vi.fn(async (url: string, init: Parameters<DevelopmentFetch>[1]) => {
      expect(url).toBe("https://app.kavaroutes.com/v1/me");
      expect(init.credentials).toBe("same-origin");
      expect(init.headers.authorization).toBe("Synthetic principal_driver");
      return response({ principalKind: "SYNTHETIC_DEVICE", organizations: [{ organizationId: driverOrganizationId, capabilities: ["driver:manifest:read", "driver:execute"] }] });
    }) as unknown as DevelopmentFetch;
    const session = await createCloudDriverWebApi("https://app.kavaroutes.com", fetcher).authenticate();
    expect(session.value.organizationId).toBe(driverOrganizationId);
    expect(fetcher).toHaveBeenCalledOnce();
  });
});
