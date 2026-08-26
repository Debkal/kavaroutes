import type { DriverActionBatch, DriverManifest, LocationBatch } from "@kavaroutes/api-contracts";
import type { DriverAction, DriverLocationSample } from "./contracts.js";

export type DriverManifestProjection = DriverManifest;

export function toWp007ActionBatch(action: DriverAction, deviceSessionId: string): DriverActionBatch {
  return Object.freeze({ deviceSessionId, items: [Object.freeze({ clientActionId: action.actionId, deviceEpoch: action.deviceEpoch, sequence: action.sequence,
    capturedAt: action.capturedAt, command: action.command, resourceReference: action.resourceReference, expectedTag: action.expectedTag, idempotencyKey: action.idempotencyKey })] });
}

export function toWp007LocationBatch(samples: readonly DriverLocationSample[], deviceId: string): LocationBatch {
  if (samples.length < 1 || samples.length > 500) throw new Error("DRIVER_LOCATION_BATCH_SIZE_INVALID");
  return Object.freeze({ deviceId, samples: samples.map((sample) => Object.freeze({ sampleId: sample.sampleId, deviceEpoch: sample.epoch, sequence: sample.sequence,
    capturedAt: sample.capturedAt, latitude: sample.latitude, longitude: sample.longitude })) });
}
