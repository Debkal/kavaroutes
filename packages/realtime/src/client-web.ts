import { createReferenceSyncClient, type ClientProjectionPersistence } from "./client.js";

/** Compile-only browser seam. WP011 owns React and browser persistence. */
export function createCompileOnlyWebRealtimeAdapter(persistence: ClientProjectionPersistence) {
  return createReferenceSyncClient(persistence);
}
