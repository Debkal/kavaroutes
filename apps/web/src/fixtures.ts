import type { BoardProjection, BoardStatus, BoardTrip, VehiclePosition } from "./contracts";

const STATUSES: readonly BoardStatus[] = ["SCHEDULED", "READY", "IN_PROGRESS", "LATE", "COMPLETED"];

function pad(value: number, length = 4): string { return String(value).padStart(length, "0"); }

export function makeTrips(count: number): readonly BoardTrip[] {
  return Object.freeze(Array.from({ length: count }, (_, index) => {
    const ordinal = index + 1;
    const hour = 6 + Math.floor((index % 720) / 60);
    const minute = index % 60;
    return Object.freeze({
      reference: `trip-synthetic-${pad(ordinal, 5)}`,
      riderLabel: `Rider ${pad(ordinal)}`,
      pickupLabel: `Pickup zone ${String.fromCharCode(65 + (index % 6))}`,
      dropoffLabel: `Drop-off zone ${String.fromCharCode(65 + ((index + 2) % 6))}`,
      scheduledTime: `${pad(hour, 2)}:${pad(minute, 2)}`,
      status: STATUSES[index % STATUSES.length] ?? "SCHEDULED",
      driverLabel: index % 7 === 0 ? null : `Driver ${pad((index % 75) + 1, 3)}`,
      vehicleLabel: index % 7 === 0 ? null : `Vehicle ${pad((index % 75) + 1, 3)}`,
      facilityReference: index % 2 === 0 ? "facility-synthetic-alpha" : "facility-synthetic-beta",
      version: 1,
    });
  }));
}

export function makePositions(count: number): readonly VehiclePosition[] {
  return Object.freeze(Array.from({ length: count }, (_, index) => Object.freeze({
    vehicleReference: `vehicle-synthetic-${pad(index + 1, 4)}`,
    displayLabel: `Vehicle ${pad(index + 1, 3)}`,
    x: 8 + ((index * 17) % 82),
    y: 10 + ((index * 29) % 76),
    stale: index % 11 === 0,
    version: 1,
  })));
}

export function makeBoardProjection(tripCount = 500, vehicleCount = 25): BoardProjection {
  return Object.freeze({
    organizationReference: "organization-synthetic-alpha",
    serviceDate: "2026-08-28",
    version: 1,
    connection: "LIVE",
    trips: makeTrips(tripCount),
    positions: makePositions(vehicleCount),
  });
}
