import { useSyncExternalStore } from "react";
import type { BoardProjection, BoardTrip, ConnectionState, VehiclePosition } from "./contracts";

export interface ProjectionStore {
  getSnapshot(): BoardProjection;
  subscribe(listener: () => void): () => void;
  replace(next: BoardProjection): void;
  setConnection(connection: ConnectionState): void;
  confirmAssignment(reference: string, driverLabel: string, nextVersion: number): void;
  applyPositions(changes: readonly VehiclePosition[]): void;
  reset(next: BoardProjection): void;
}

export function createProjectionStore(initial: BoardProjection): ProjectionStore {
  let snapshot = initial;
  const listeners = new Set<() => void>();
  const publish = () => { for (const listener of listeners) listener(); };
  return Object.freeze({
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) { listeners.add(listener); return () => listeners.delete(listener); },
    replace(next: BoardProjection) { snapshot = next; publish(); },
    setConnection(connection: ConnectionState) { snapshot = Object.freeze({ ...snapshot, connection }); publish(); },
    confirmAssignment(reference: string, driverLabel: string, nextVersion: number) {
      const trips: readonly BoardTrip[] = snapshot.trips.map((trip) => trip.reference === reference
        ? Object.freeze({ ...trip, driverLabel, vehicleLabel: driverLabel.replace("Driver", "Vehicle"), version: nextVersion })
        : trip);
      snapshot = Object.freeze({ ...snapshot, trips, version: snapshot.version + 1 }); publish();
    },
    applyPositions(changes: readonly VehiclePosition[]) {
      const byReference = new Map(snapshot.positions.map((position) => [position.vehicleReference, position]));
      for (const change of changes) {
        const current = byReference.get(change.vehicleReference);
        if (!current || change.version > current.version) byReference.set(change.vehicleReference, change);
      }
      snapshot = Object.freeze({ ...snapshot, positions: Object.freeze([...byReference.values()]) }); publish();
    },
    reset(next: BoardProjection) { snapshot = Object.freeze({ ...next, connection: "LIVE" }); publish(); },
  });
}

export function useProjection(store: ProjectionStore): BoardProjection {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}
