import { describe, expect, it } from "vitest";
import { makeBoardProjection } from "../src/fixtures";
import { createGeneratedAssignmentClient } from "../src/generated-command-client";
import { SYNTHETIC_PRINCIPALS, assertFacilityScope } from "../src/identity";
import { createSyntheticMapPort } from "../src/map-port";
import { createProjectionStore } from "../src/projection-store";
import { queryKeys } from "../src/query-keys";
import { createWebRealtimeRecovery } from "../src/realtime-recovery";
import { createSyntheticApi, SyntheticApiProblem } from "../src/synthetic-api";

describe("WP011 contracts", () => {
  it("separates query caches by organization, principal, purpose, and projection", () => {
    const dispatch = queryKeys.board({ organizationReference: "organization-a", principalReference: "principal-a", purpose: "DISPATCH_CONTROL", projection: "DAY_BOARD" }, "2026-08-28");
    const facility = queryKeys.board({ organizationReference: "organization-a", principalReference: "principal-a", purpose: "FACILITY_COORDINATION", projection: "FACILITY_DAY" }, "2026-08-28");
    expect(dispatch).not.toEqual(facility);
    expect(() => queryKeys.board({ organizationReference: "organization-a?token=forbidden", principalReference: "principal-a", purpose: "DISPATCH_CONTROL", projection: "DAY_BOARD" }, "2026-08-28")).toThrow("UNSAFE_QUERY_CONTEXT");
  });

  it("denies wrong-facility and expired principals", async () => {
    const api = createSyntheticApi(makeBoardProjection());
    await expect(api.getFacilityDay(SYNTHETIC_PRINCIPALS.wrongFacility, "facility-synthetic-alpha")).rejects.toThrow("FACILITY_SCOPE_DENIED");
    expect(() => assertFacilityScope(SYNTHETIC_PRINCIPALS.expired, "facility-synthetic-alpha")).toThrow("SESSION_EXPIRED");
    const allowed = await api.getFacilityDay(SYNTHETIC_PRINCIPALS.facilityAlpha, "facility-synthetic-alpha");
    expect(allowed.positions).toHaveLength(0);
    expect(allowed.trips.every((trip) => trip.facilityReference === "facility-synthetic-alpha" && trip.driverLabel === null)).toBe(true);
  });

  it("never updates material state before a command receipt and converges after a lost response", async () => {
    const initial = makeBoardProjection(10, 2);
    const api = createSyntheticApi(initial);
    const trip = initial.trips[0]!;
    const request = { tripReference: trip.reference, driverLabel: "Driver 042", expectedVersion: trip.version, idempotencyKey: "idempotency-stable-1" };
    await expect(api.assign(SYNTHETIC_PRINCIPALS.dispatcherAlpha, request, "LOST_RESPONSE")).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN" });
    expect(api.snapshot().trips[0]?.driverLabel).toBe("Driver 042");
    await expect(api.assign(SYNTHETIC_PRINCIPALS.dispatcherAlpha, request)).resolves.toMatchObject({ outcome: "REPLAYED" });
  });

  it("executes the representative command through the generated WP007 client seam", async () => {
    const initial = makeBoardProjection(2, 1); const api = createSyntheticApi(initial); const trip = initial.trips[0]!;
    const client = createGeneratedAssignmentClient(api, SYNTHETIC_PRINCIPALS.dispatcherAlpha);
    await expect(client.assign({ tripReference: trip.reference, driverLabel: "Driver 042", expectedVersion: 1, idempotencyKey: "generated-command-1" }, "NONE")).resolves.toMatchObject({ outcome: "ACCEPTED", nextVersion: 2 });
    await expect(client.assign({ tripReference: trip.reference, driverLabel: "Driver 043", expectedVersion: 1, idempotencyKey: "generated-command-2" }, "CONFLICT_409")).rejects.toMatchObject({ status: 409, code: "ASSIGNMENT_CONFLICT" });
  });

  it("rejects stale concurrent assignment without last-write-wins", async () => {
    const initial = makeBoardProjection(10, 2); const api = createSyntheticApi(initial); const trip = initial.trips[0]!;
    await api.assign(SYNTHETIC_PRINCIPALS.dispatcherAlpha, { tripReference: trip.reference, driverLabel: "Driver 042", expectedVersion: 1, idempotencyKey: "first" });
    await expect(api.assign(SYNTHETIC_PRINCIPALS.dispatcherBeta, { tripReference: trip.reference, driverLabel: "Driver 043", expectedVersion: 1, idempotencyKey: "second" })).rejects.toBeInstanceOf(SyntheticApiProblem);
    expect(api.snapshot().trips[0]?.driverLabel).toBe("Driver 042");
  });

  it("uses the WP009 web recovery contract for replay, duplicate, gap, and reset", async () => {
    const recovery = createWebRealtimeRecovery();
    recovery.client.transition("AUTHENTICATING"); recovery.client.transition("REPLAYING");
    const change = { streamId: "00000000-0000-4000-8000-000000000011", epoch: 1, sequence: 1, schemaVersion: "realtime.schema.v1", committedAt: "2026-08-28T12:00:00.000Z", delta: { kind: "DISPATCH_CONTROL", tripReference: "trip-synthetic-00001", lifecycle: "SCHEDULED", resourceVersion: 1 } } as const;
    expect(await recovery.client.applyBatch([change], "cursor-one")).toBe("APPLIED");
    expect(await recovery.client.applyBatch([change], "cursor-one")).toBe("DUPLICATE");
    recovery.client.transition("LIVE");
    expect(await recovery.client.applyBatch([{ ...change, sequence: 3, delta: { ...change.delta, resourceVersion: 3 } }], "cursor-gap")).toBe("GAP");
    expect(recovery.client.state()).toBe("STALE");
    await recovery.client.reset();
    expect(recovery.client.state()).toBe("SNAPSHOT_REQUIRED");
  });

  it("coalesces map updates on one frame and cleans listeners", () => {
    let callback: FrameRequestCallback | undefined;
    const port = createSyntheticMapPort((next) => { callback = next; return 1; }, () => undefined);
    port.mount(); const unsubscribe = port.subscribe(() => undefined);
    const positions = makeBoardProjection(1, 1).positions;
    port.updatePositions(positions); port.updatePositions([{ ...positions[0]!, version: 2, x: 42 }]);
    expect(port.snapshot().markers).toHaveLength(0);
    callback?.(1);
    expect(port.snapshot().markers[0]).toMatchObject({ version: 2, x: 42 });
    unsubscribe(); port.unmount(); expect(port.snapshot().listenerCount).toBe(0);
  });

  it("applies only newer projection versions", () => {
    const initial = makeBoardProjection(1, 1); const store = createProjectionStore(initial); const current = initial.positions[0]!;
    store.applyPositions([{ ...current, version: 2, x: 55 }, { ...current, version: 1, x: 99 }]);
    expect(store.getSnapshot().positions[0]).toMatchObject({ version: 2, x: 55 });
  });
});
