import type { DriverAction, DriverLocationSample, EvidenceDraft, TrackingState } from "./contracts.js";

export interface SecureKeyPort {
  read(reference: string): Promise<string | null>;
  create(reference: string): Promise<string>;
  remove(reference: string): Promise<void>;
}

export interface EncryptedDriverStorePort {
  initialize(binding: { readonly installationGeneration: string; readonly keyMaterial: string }): Promise<"CREATED" | "OPENED" | "QUARANTINED">;
  transaction<T>(operation: (store: DriverStoreTransaction) => Promise<T>): Promise<T>;
  integrityCheck(): Promise<boolean>;
  wipe(): Promise<void>;
}

export interface DriverStoreTransaction {
  saveProjection(snapshot: unknown, cursor: string): Promise<void>;
  enqueueAction(action: DriverAction): Promise<void>;
  updateAction(actionId: string, state: DriverAction["state"], attempt: number): Promise<void>;
  appendLocations(samples: readonly DriverLocationSample[]): Promise<void>;
  saveEvidence(draft: EvidenceDraft): Promise<void>;
}

export interface PermissionPort {
  inspect(): Promise<{ readonly foreground: "GRANTED" | "DENIED" | "UNDETERMINED"; readonly background: "GRANTED" | "DENIED" | "UNDETERMINED"; readonly precise: boolean }>;
  requestForeground(): Promise<void>;
  requestBackground(): Promise<void>;
}

export interface BackgroundLocationPort {
  start(generation: string): Promise<void>;
  stop(): Promise<void>;
  registered(): Promise<boolean>;
}

export interface NavigationPort {
  canOpen(url: string): Promise<boolean>;
  open(url: string): Promise<void>;
}

export interface DriverTransportPort {
  uploadAction(action: DriverAction): Promise<{ readonly outcome: "ACCEPTED" | "CONFLICT" | "PERMANENT_REJECTION" | "UNKNOWN"; readonly status: number }>;
  uploadLocations(samples: readonly DriverLocationSample[]): Promise<readonly { readonly sampleId: string; readonly outcome: "APPLIED" | "REPLAYED" | "REJECTED" }[]>;
  uploadEvidence(draft: EvidenceDraft): Promise<{ readonly outcome: "ACCEPTED" | "REJECTED" | "UNKNOWN" }>;
}

export interface SafeDiagnosticsPort {
  record(event: { readonly metric: string; readonly outcome: string; readonly state?: TrackingState; readonly durationBucket?: string }): void;
}
