import { createCompileOnlyNativeRealtimeAdapter } from "@kavaroutes/realtime/client-native";
import type { ClientProjectionPersistence } from "@kavaroutes/realtime";

export function createDriverRecoveryClient(persistence: ClientProjectionPersistence) {
  return createCompileOnlyNativeRealtimeAdapter(persistence);
}
