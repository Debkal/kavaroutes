import type { DriverAction, DriverLocationSample, EvidenceDraft } from "./contracts.js";
import type { DriverStoreTransaction, EncryptedDriverStorePort } from "./ports.js";

interface State { bindingHash: string | null; quarantined: boolean; cursor: string | null; projection: unknown; actions: Map<string, DriverAction>; locations: Map<string, DriverLocationSample>; evidence: Map<string, EvidenceDraft> }
const clone = (state: State): State => ({ ...state, actions: new Map(state.actions), locations: new Map(state.locations), evidence: new Map(state.evidence) });
// Deterministic fake marker only. Native key/database binding is delegated to SQLCipher and OS key storage.
const bindingMarker = (generation: string, key: string) => `${generation.length}:${generation}:${key.length}:${key}`;

export function createDeterministicEncryptedStoreFake(): EncryptedDriverStorePort & { inspect(): Readonly<State> } {
  let state: State = { bindingHash: null, quarantined: false, cursor: null, projection: null, actions: new Map(), locations: new Map(), evidence: new Map() };
  return Object.freeze({
    async initialize(binding: { readonly installationGeneration: string; readonly keyMaterial: string }) {
      const next = bindingMarker(binding.installationGeneration, binding.keyMaterial);
      if (state.quarantined) return "QUARANTINED";
      if (state.bindingHash === null) { state.bindingHash = next; return "CREATED"; }
      if (state.bindingHash !== next) { state.quarantined = true; return "QUARANTINED"; }
      return "OPENED";
    },
    async transaction<T>(operation: (store: DriverStoreTransaction) => Promise<T>) {
      if (state.quarantined || state.bindingHash === null) throw new Error("DRIVER_STORE_UNAVAILABLE");
      const working = clone(state);
      const tx: DriverStoreTransaction = {
        async saveProjection(snapshot, cursor) { working.projection = structuredClone(snapshot); working.cursor = cursor; },
        async enqueueAction(action) { if (working.actions.has(action.actionId)) throw new Error("ACTION_DUPLICATE"); working.actions.set(action.actionId, action); },
        async updateAction(actionId, next, attempt) { const action = working.actions.get(actionId); if (!action) throw new Error("ACTION_NOT_FOUND"); working.actions.set(actionId, { ...action, state: next, attempt }); },
        async appendLocations(samples) { for (const sample of samples) { const key = `${sample.epoch}:${sample.sequence}`; if (!working.locations.has(key)) working.locations.set(key, sample); } },
        async saveEvidence(draft) { working.evidence.set(draft.draftId, draft); },
      };
      const result = await operation(tx);
      state = working;
      return result;
    },
    async integrityCheck() { return !state.quarantined && state.bindingHash !== null; },
    async wipe() { state = { bindingHash: null, quarantined: false, cursor: null, projection: null, actions: new Map(), locations: new Map(), evidence: new Map() }; },
    inspect() { return clone(state); },
  });
}
