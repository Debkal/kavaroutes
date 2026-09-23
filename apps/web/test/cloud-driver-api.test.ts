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
  plannedStartAt: "2026-09-14T15:00:00.000Z", plannedEndAt: "2026-09-14T16:00:00.000Z", appointmentLengthMinutes:60, serviceTimezone: "America/Los_Angeles",
};

describe("Driver web cloud adapter", () => {
  it("accepts only the authenticated Driver itinerary projection", () => {
    const driverId="44444444-4444-4444-8444-444444444444";
    const value = decodeDriverItinerary({ driverReference: driverId, serviceDate: "2026-09-14", legs: [leg] },driverId);
    expect(value.legs[0]?.tripLegId).toBe(leg.tripLegId);
    expect(() => decodeDriverItinerary({ driverReference: "40000000-0000-4000-8000-000000000001", serviceDate: "2026-09-14", legs: [leg] },driverId)).toThrow("INVALID_DRIVER_ITINERARY");
  });

  it("uses the verified driver's memory-only session for itinerary requests", async () => {
    const driverId="44444444-4444-4444-8444-444444444444", token=`dvs_${'a'.repeat(43)}`;
    const fetcher = vi.fn(async (url: string, init: Parameters<DevelopmentFetch>[1]) => {
      expect(init.credentials).toBe("same-origin");
      if(url.endsWith('/driver-logins/commands/verify')){
        expect(init.headers.authorization).toBeUndefined();
        return response({driverId,loginId:'joel',status:'ACTIVE',claimedAt:'2026-09-23T19:00:00Z',lastLoginAt:'2026-09-23T19:00:00Z',version:2,sessionToken:token});
      }
      expect(init.headers.authorization).toBe(`DriverSession ${token}`);
      if(url.endsWith('/v1/me'))return response({principalKind:'SYNTHETIC_DEVICE',organizations:[{organizationId:driverOrganizationId,capabilities:['driver:manifest:read','driver:execute']}]});
      return response({driverReference:driverId,serviceDate:'2026-09-14',legs:[leg]});
    }) as unknown as DevelopmentFetch;
    const api=createCloudDriverWebApi("https://app.kavaroutes.com", fetcher);
    await expect(api.authenticate()).rejects.toThrow('DRIVER_SESSION_REQUIRED');
    await api.verifyLogin({loginId:'joel',password:'test-password'},'test-key');
    const session=await api.authenticate();
    expect(session.value.organizationId).toBe(driverOrganizationId);
    expect((await api.itinerary('2026-09-14')).value.driverReference).toBe(driverId);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
});
