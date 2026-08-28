import type { VehiclePosition } from "./contracts";

export type MapState = "READY" | "SLOW" | "UNAVAILABLE" | "ERROR" | "QUOTA_DEGRADED";
export interface ViewportIntent { readonly kind: "FIT_ALL" | "FOCUS_VEHICLE"; readonly reference?: string; }
export interface MapSnapshot { readonly state: MapState; readonly selectedReference: string | null; readonly markers: readonly VehiclePosition[]; readonly clusters: number; readonly listenerCount: number; }
export interface MapPort {
  mount(): void;
  unmount(): void;
  setState(state: MapState): void;
  select(reference: string | null): void;
  updatePositions(changes: readonly VehiclePosition[]): void;
  requestViewport(intent: ViewportIntent): void;
  subscribe(listener: () => void): () => void;
  snapshot(): MapSnapshot;
  dispose(): void;
}

export function createSyntheticMapPort(schedule: (callback: FrameRequestCallback) => number = requestAnimationFrame, cancel: (handle: number) => void = cancelAnimationFrame): MapPort {
  let mounted = false;
  let disposed = false;
  let frame: number | null = null;
  let state: MapState = "READY";
  let selectedReference: string | null = null;
  let markers: readonly VehiclePosition[] = [];
  const pending = new Map<string, VehiclePosition>();
  const listeners = new Set<() => void>();
  let snapshotCache: MapSnapshot = Object.freeze({ state, selectedReference, markers, clusters: 0, listenerCount: 0 });
  const refresh = () => { snapshotCache = Object.freeze({ state, selectedReference, markers, clusters: Math.ceil(markers.length / 20), listenerCount: mounted ? listeners.size : 0 }); };
  const notify = () => { refresh(); for (const listener of listeners) listener(); };
  const ensureActive = () => { if (disposed) throw new Error("MAP_PORT_DISPOSED"); };
  const flush = () => {
    frame = null;
    const merged = new Map(markers.map((marker) => [marker.vehicleReference, marker]));
    for (const [reference, update] of pending) {
      const current = merged.get(reference);
      if (!current || update.version > current.version) merged.set(reference, update);
    }
    pending.clear(); markers = Object.freeze([...merged.values()]); notify();
  };
  return Object.freeze({
    mount() { ensureActive(); mounted = true; notify(); },
    unmount() { mounted = false; if (frame !== null) cancel(frame); frame = null; pending.clear(); listeners.clear(); refresh(); },
    setState(next: MapState) { ensureActive(); state = next; notify(); },
    select(reference: string | null) { ensureActive(); selectedReference = reference; notify(); },
    updatePositions(changes: readonly VehiclePosition[]) { ensureActive(); for (const change of changes) pending.set(change.vehicleReference, change); if (frame === null) frame = schedule(flush); },
    requestViewport(intent: ViewportIntent) { ensureActive(); if (intent.kind === "FOCUS_VEHICLE" && !intent.reference) throw new Error("MAP_VIEWPORT_REFERENCE_REQUIRED"); },
    subscribe(listener: () => void) { ensureActive(); listeners.add(listener); return () => listeners.delete(listener); },
    snapshot() { return snapshotCache; },
    dispose() { if (frame !== null) cancel(frame); frame = null; pending.clear(); listeners.clear(); mounted = false; disposed = true; refresh(); },
  });
}
