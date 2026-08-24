import { NodeSDK } from "@opentelemetry/sdk-node";

export function initializeWorkerTelemetry(): Readonly<{ shutdown(): Promise<void> }> {
  const sdk = new NodeSDK({ serviceName: "kavaroutes-wp005-worker" });
  sdk.start();
  return Object.freeze({ shutdown: () => sdk.shutdown() });
}
