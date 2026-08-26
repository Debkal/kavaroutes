import { createWp007Api, type Wp007ApiOptions } from "@kavaroutes/api-contracts";
import type { RealtimeStore, AuthorizationGenerationSource, RealtimeTelemetryEvent } from "@kavaroutes/realtime";
import { registerWp009Realtime } from "@kavaroutes/realtime/fastify";

/** Local/in-process composition only. The public main listener intentionally does not register WP009. */
export async function createLocalWp009Api(options: {
  readonly store: RealtimeStore;
  readonly generationSource: AuthorizationGenerationSource;
  readonly wp007?: Wp007ApiOptions;
  readonly allowedOrigins?: ReadonlySet<string>;
  readonly telemetrySink?: (event: RealtimeTelemetryEvent) => void;
}) {
  const app = await createWp007Api(options.wp007);
  const gateway = await registerWp009Realtime(app, { store: options.store, generationSource: options.generationSource,
    ...(options.allowedOrigins ? { allowedOrigins: options.allowedOrigins } : {}), ...(options.telemetrySink ? { telemetrySink: options.telemetrySink } : {}) });
  return Object.freeze({ app, gateway });
}
