import * as Location from "expo-location";
import * as TaskManager from "expo-task-manager";
import { DEFAULT_SAMPLING_POLICY, normalizeLocation, type DriverLocationSample } from "@kavaroutes/driver-core";

export const DRIVER_LOCATION_TASK = "krd-background-location-v1";
let activeGeneration: string | null = null;
let sequence = 0;
let persistSamples: (samples: readonly DriverLocationSample[]) => Promise<void> = async () => undefined;
export function configureBackgroundLocation(input: { readonly generation: string; readonly persist: (samples: readonly DriverLocationSample[]) => Promise<void> }) {
  if (!/^trk_[a-z0-9]{16,64}$/.test(input.generation)) throw new Error("TRACKING_GENERATION_INVALID");
  activeGeneration = input.generation; persistSamples = input.persist;
}
TaskManager.defineTask(DRIVER_LOCATION_TASK, async ({ data, error }) => {
  if (error || activeGeneration === null || typeof data !== "object" || data === null || !("locations" in data) || !Array.isArray(data.locations)) return;
  const locations = (data.locations as Location.LocationObject[]).slice(0, 100).map((location) => normalizeLocation({
    sampleId: `loc_${activeGeneration!.slice(4)}${String(++sequence).padStart(8, "0")}`.slice(0, 68), epoch: 1, sequence,
    capturedAt: new Date(location.timestamp).toISOString(), latitude: location.coords.latitude, longitude: location.coords.longitude,
    accuracyMeters: location.coords.accuracy ?? 10_000,
  }, DEFAULT_SAMPLING_POLICY));
  await persistSamples(locations);
});
