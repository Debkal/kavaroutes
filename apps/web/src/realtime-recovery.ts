import { createCompileOnlyWebRealtimeAdapter } from "@kavaroutes/realtime/client-web";
import type { ClientProjectionPersistence, RealtimeChange } from "@kavaroutes/realtime";

function safeDigest(values: ReadonlyMap<string, number>, cursorPresent: boolean): string {
  const input = JSON.stringify({ cursorPresent, values: [...values].sort(([left], [right]) => left.localeCompare(right)) });
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) hash = Math.imul(hash ^ input.charCodeAt(index), 0x01000193);
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function createWebRealtimeRecovery() {
  const versions = new Map<string, number>();
  let cursorPresent = false;
  const persistence: ClientProjectionPersistence = Object.freeze({
    async apply(changes: readonly RealtimeChange[]) {
      for (const change of changes) {
        const delta = change.delta;
        const reference = "resourceReference" in delta ? delta.resourceReference : "tripReference" in delta ? delta.tripReference : "driverReference" in delta ? delta.driverReference : "manifestReference" in delta ? delta.manifestReference : delta.operationReference;
        versions.set(`${delta.kind}:${reference}`, Math.max(versions.get(`${delta.kind}:${reference}`) ?? 0, delta.resourceVersion));
      }
    },
    async persistCursor() { cursorPresent = true; },
    async clear() { versions.clear(); cursorPresent = false; },
    digest() { return safeDigest(versions, cursorPresent); },
  });
  return Object.freeze({ client: createCompileOnlyWebRealtimeAdapter(persistence), digest: () => persistence.digest() });
}
