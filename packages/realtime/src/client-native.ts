import { createReferenceSyncClient, type ClientProjectionPersistence } from "./client.js";

/** Compile-only native seam. WP010 owns lifecycle and encrypted device persistence. */
export function createCompileOnlyNativeRealtimeAdapter(persistence: ClientProjectionPersistence) {
  return createReferenceSyncClient(persistence);
}
