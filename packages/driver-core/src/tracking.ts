import type { DriverLocationSample, SamplingPolicy, TrackingState } from "./contracts.js";

export function resolveTrackingState(input: { readonly configured: boolean; readonly foreground: string; readonly background: string; readonly precise: boolean;
  readonly active: boolean; readonly stopped: boolean; readonly systemPaused: boolean; readonly revoked: boolean; readonly lastSampleAt?: Date; readonly now: Date;
  readonly policy: SamplingPolicy }): TrackingState {
  if (!input.configured) return "NOT_CONFIGURED";
  if (input.revoked) return "REVOKED";
  if (input.stopped) return "STOPPED_BY_DRIVER";
  if (input.foreground !== "GRANTED" || input.background !== "GRANTED") return "PERMISSION_REQUIRED";
  if (!input.precise) return "DEGRADED_APPROXIMATE";
  if (input.systemPaused) return "PAUSED_BY_SYSTEM";
  if (!input.active) return "READY";
  if (!input.lastSampleAt || input.now.getTime() - input.lastSampleAt.getTime() > input.policy.staleAfterSeconds * 1000) return "STALE";
  return "TRACKING";
}

export function normalizeLocation(input: Omit<DriverLocationSample, "policyVersion">, policy: SamplingPolicy): DriverLocationSample {
  if (!Number.isFinite(input.latitude) || input.latitude < -90 || input.latitude > 90 || !Number.isFinite(input.longitude) || input.longitude < -180 || input.longitude > 180) throw new Error("LOCATION_RANGE_INVALID");
  if (!Number.isInteger(input.sequence) || input.sequence < 1 || !Number.isInteger(input.epoch) || input.epoch < 1) throw new Error("LOCATION_SEQUENCE_INVALID");
  if (!Number.isFinite(input.accuracyMeters) || input.accuracyMeters < 0 || input.accuracyMeters > 10_000) throw new Error("LOCATION_ACCURACY_INVALID");
  return Object.freeze({ ...input, policyVersion: policy.version });
}

export function createLocationBatches(samples: readonly DriverLocationSample[], policy: SamplingPolicy): readonly (readonly DriverLocationSample[])[] {
  const sorted = [...samples].sort((left, right) => left.epoch - right.epoch || left.sequence - right.sequence);
  const batches: DriverLocationSample[][] = [];
  let batch: DriverLocationSample[] = [];
  let bytes = 2;
  for (const sample of sorted) {
    const sampleBytes = Buffer.byteLength(JSON.stringify(sample)) + (batch.length === 0 ? 0 : 1);
    if (batch.length >= policy.maximumBatchItems || bytes + sampleBytes > policy.maximumBatchBytes) { if (batch.length > 0) batches.push(batch); batch = []; bytes = 2; }
    if (sampleBytes + 2 > policy.maximumBatchBytes) throw new Error("LOCATION_SAMPLE_TOO_LARGE");
    batch.push(sample); bytes += sampleBytes;
  }
  if (batch.length > 0) batches.push(batch);
  return batches.map((batch) => Object.freeze(batch));
}
