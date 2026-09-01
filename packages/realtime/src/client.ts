import type { RealtimeChange } from "./contracts.js";

const REALTIME_CLIENT_SCHEMA_VERSION = "realtime.schema.v1" as const;

function diagnosticChecksum(value: string): string {
  const seeds = [0x811c9dc5, 0x9e3779b9, 0x85ebca6b, 0xc2b2ae35, 0x27d4eb2f, 0x165667b1, 0xd3a2646c, 0xfd7046c5];
  return seeds.map((seed) => { let hash = seed; for (let index = 0; index < value.length; index += 1) hash = Math.imul(hash ^ value.charCodeAt(index), 0x01000193); return (hash >>> 0).toString(16).padStart(8, "0"); }).join("");
}

export type RealtimeClientState = "DISCONNECTED" | "RECONNECTING" | "AUTHENTICATING" | "SNAPSHOT_REQUIRED" | "REPLAYING" | "LIVE" | "STALE" | "STOPPED";

export interface ClientProjectionPersistence {
  apply(changes: readonly RealtimeChange[]): Promise<void>;
  persistCursor(cursor: string): Promise<void>;
  clear(): Promise<void>;
  digest(): string;
}

function resourceKey(change: RealtimeChange): string {
  const delta = change.delta;
  if (delta.kind === "CURRENT_POSITION") return `driver:${delta.driverReference}`;
  if (delta.kind === "DRIVER_MANIFEST") return `manifest:${delta.manifestReference}`;
  if (delta.kind === "OPERATION_PROGRESS") return `operation:${delta.operationReference}`;
  return `resource:${"resourceReference" in delta ? delta.resourceReference : delta.tripReference}`;
}

export function createMemoryClientProjection(control: { readonly failApply?: () => boolean; readonly failPersist?: () => boolean } = {}): ClientProjectionPersistence {
  const versions = new Map<string, { version: number; value: unknown }>();
  let persistedCursor: string | null = null;
  return Object.freeze({
    async apply(changes: readonly RealtimeChange[]) {
      if (control.failApply?.()) throw new Error("SYNTHETIC_CLIENT_APPLY_FAILURE");
      for (const change of changes) {
        const delta = change.delta;
        const key = resourceKey(change);
        const current = versions.get(key);
        if (!current || delta.resourceVersion > current.version) versions.set(key, { version: delta.resourceVersion, value: delta });
      }
    },
    async persistCursor(cursor: string) { if (control.failPersist?.()) throw new Error("SYNTHETIC_CLIENT_CURSOR_FAILURE"); persistedCursor = cursor; },
    async clear() { versions.clear(); persistedCursor = null; },
    digest() { return diagnosticChecksum(JSON.stringify({ cursorPresent: persistedCursor !== null, values: [...versions.entries()].sort(([left], [right]) => left.localeCompare(right)) })); },
  });
}

export function createReferenceSyncClient(persistence: ClientProjectionPersistence) {
  let state: RealtimeClientState = "DISCONNECTED";
  const vectors = new Map<string, { epoch: number; sequence: number }>();
  const resourceVersions = new Map<string, number>();

  function transition(next: RealtimeClientState): void {
    const allowed: Readonly<Record<RealtimeClientState, readonly RealtimeClientState[]>> = {
      DISCONNECTED: ["RECONNECTING", "AUTHENTICATING", "STOPPED"], RECONNECTING: ["AUTHENTICATING", "DISCONNECTED", "STOPPED"],
      AUTHENTICATING: ["SNAPSHOT_REQUIRED", "REPLAYING", "DISCONNECTED", "STOPPED"], SNAPSHOT_REQUIRED: ["REPLAYING", "DISCONNECTED", "STOPPED"],
      REPLAYING: ["LIVE", "STALE", "SNAPSHOT_REQUIRED", "DISCONNECTED", "STOPPED"], LIVE: ["STALE", "REPLAYING", "DISCONNECTED", "STOPPED"],
      STALE: ["REPLAYING", "SNAPSHOT_REQUIRED", "DISCONNECTED", "STOPPED"], STOPPED: [],
    };
    if (!allowed[state].includes(next)) throw new Error(`CLIENT_STATE_TRANSITION_INVALID:${state}:${next}`);
    state = next;
  }

  function gap(): "GAP" {
    if (state === "LIVE" || state === "REPLAYING") transition("STALE");
    return "GAP";
  }

  function classify(change: RealtimeChange): "ACCEPT" | "DUPLICATE" | "GAP" {
    if (change.schemaVersion !== REALTIME_CLIENT_SCHEMA_VERSION) return "GAP";
    const current = vectors.get(change.streamId);
    if (!current) {
      if (change.sequence !== 1) return "GAP";
    } else {
      if (change.epoch !== current.epoch || change.sequence > current.sequence + 1) return "GAP";
      if (change.sequence <= current.sequence) return "DUPLICATE";
    }
    const version = resourceVersions.get(resourceKey(change));
    return version !== undefined && change.delta.resourceVersion < version ? "GAP" : "ACCEPT";
  }

  async function commit(changes: readonly RealtimeChange[], cursor: string): Promise<void> {
    await persistence.apply(changes);
    await persistence.persistCursor(cursor);
    for (const change of changes) {
      vectors.set(change.streamId, { epoch: change.epoch, sequence: change.sequence });
      const key = resourceKey(change);
      resourceVersions.set(key, Math.max(resourceVersions.get(key) ?? 0, change.delta.resourceVersion));
    }
  }

  async function applyBatch(changes: readonly RealtimeChange[], cursor: string): Promise<"APPLIED" | "DUPLICATE" | "GAP"> {
    const accepted: RealtimeChange[] = [];
    for (const change of changes) {
      const classification = classify(change);
      if (classification === "GAP") return gap();
      if (classification === "DUPLICATE") continue;
      accepted.push(change);
    }
    if (accepted.length === 0) return "DUPLICATE";
    await commit(accepted, cursor);
    return "APPLIED";
  }

  return Object.freeze({
    state: () => state,
    transition,
    applyBatch,
    async reset() { await persistence.clear(); vectors.clear(); resourceVersions.clear(); if (state !== "SNAPSHOT_REQUIRED") transition("SNAPSHOT_REQUIRED"); },
    stop() { if (state !== "STOPPED") transition("STOPPED"); },
  });
}

export function reconnectDelay(attempt: number, random: () => number = Math.random): number {
  if (!Number.isInteger(attempt) || attempt < 0) throw new Error("RECONNECT_ATTEMPT_INVALID");
  const ceiling = Math.min(30_000, 250 * (2 ** Math.min(attempt, 16)));
  return Math.floor(random() * ceiling);
}

export type CompileOnlyWebRealtimeAdapter = ReturnType<typeof createReferenceSyncClient>;
export type CompileOnlyNativeRealtimeAdapter = ReturnType<typeof createReferenceSyncClient>;
