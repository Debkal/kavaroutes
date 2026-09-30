import type { DriverAction, DriverSyncState, EvidenceDraft } from "./contracts.js";
import type { DriverTransportPort, EncryptedDriverStorePort } from "./ports.js";

const allowed: Readonly<Record<DriverSyncState, readonly DriverSyncState[]>> = Object.freeze({
  DISCONNECTED: ["RECONNECTING", "AUTHENTICATING", "OFFLINE_QUEUE_PENDING", "STOPPED"], RECONNECTING: ["AUTHENTICATING", "DISCONNECTED", "OFFLINE_QUEUE_PENDING", "STOPPED"],
  AUTHENTICATING: ["SNAPSHOT_REQUIRED", "REPLAYING", "REAUTH_REQUIRED", "DISCONNECTED"], SNAPSHOT_REQUIRED: ["REPLAYING", "REAUTH_REQUIRED", "DISCONNECTED"],
  REPLAYING: ["LIVE", "STALE", "CONFLICT", "SNAPSHOT_REQUIRED", "DISCONNECTED"], LIVE: ["STALE", "UPLOADING", "OFFLINE_QUEUE_PENDING", "DISCONNECTED", "STOPPED"],
  STALE: ["REPLAYING", "SNAPSHOT_REQUIRED", "DISCONNECTED", "REAUTH_REQUIRED"], STOPPED: [], OFFLINE_QUEUE_PENDING: ["UPLOADING", "RECONNECTING", "STOPPED"],
  UPLOADING: ["LIVE", "CONFLICT", "OFFLINE_QUEUE_PENDING", "REAUTH_REQUIRED", "DISCONNECTED"], CONFLICT: ["SNAPSHOT_REQUIRED", "REPLAYING", "STOPPED"],
  REAUTH_REQUIRED: ["AUTHENTICATING", "STOPPED"],
});

export function canonicalActionFingerprintInput(value: { readonly resourceReference: string; readonly expectedVersion: number; readonly causalSequence: number; readonly command: string }): string {
  return JSON.stringify({ resourceReference: value.resourceReference, expectedVersion: value.expectedVersion, causalSequence: value.causalSequence, command: value.command });
}

export function classifyActionResponse(status: number): { readonly actionState: DriverAction["state"]; readonly syncState: DriverSyncState } {
  if (status >= 200 && status < 300) return Object.freeze({ actionState: "ACCEPTED", syncState: "LIVE" });
  if (status === 401 || status === 403) return Object.freeze({ actionState: "PERMANENT_REJECTION", syncState: "REAUTH_REQUIRED" });
  if (status === 409 || status === 412) return Object.freeze({ actionState: "CONFLICT", syncState: "CONFLICT" });
  if (status === 422) return Object.freeze({ actionState: "PERMANENT_REJECTION", syncState: "OFFLINE_QUEUE_PENDING" });
  if (status === 429 || status >= 500) return Object.freeze({ actionState: "UNKNOWN", syncState: "OFFLINE_QUEUE_PENDING" });
  return Object.freeze({ actionState: "UNKNOWN", syncState: "OFFLINE_QUEUE_PENDING" });
}

export function createDriverSync(store: EncryptedDriverStorePort, transport: DriverTransportPort) {
  let state: DriverSyncState = "DISCONNECTED";
  const transition = (next: DriverSyncState) => { if (!allowed[state].includes(next)) throw new Error(`DRIVER_SYNC_TRANSITION_INVALID:${state}:${next}`); state = next; };
  return Object.freeze({
    state: () => state,
    transition,
    async applySnapshot(snapshot: unknown, cursor: string) { await store.transaction(async (tx) => tx.saveProjection(snapshot, cursor)); },
    async enqueue(action: DriverAction) { await store.transaction(async (tx) => tx.enqueueAction(action)); if (["DISCONNECTED", "LIVE"].includes(state)) transition("OFFLINE_QUEUE_PENDING"); },
    async uploadAction(action: DriverAction) {
      if (state === "OFFLINE_QUEUE_PENDING") transition("UPLOADING");
      const result = await transport.uploadAction(action);
      const classification = classifyActionResponse(result.status);
      await store.transaction(async (tx) => tx.updateAction(action.actionId, classification.actionState, action.attempt + 1));
      transition(classification.syncState);
      return result;
    },
    async uploadEvidence(draft: EvidenceDraft) { const result = await transport.uploadEvidence(draft); const next = result.outcome === "UNKNOWN" ? "UPLOADING" : result.outcome;
      await store.transaction(async (tx) => tx.saveEvidence({ ...draft, state: next })); return result; },
  });
}
