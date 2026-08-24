import { NodeSDK } from "@opentelemetry/sdk-node";

let sdk: NodeSDK | undefined;

export function initializeTelemetry(): Readonly<{ shutdown(): Promise<void> }> {
  if (sdk !== undefined) return Object.freeze({ shutdown: () => sdk?.shutdown() ?? Promise.resolve() });
  sdk = new NodeSDK({ serviceName: "kavaroutes-wp005-api" });
  sdk.start();
  return Object.freeze({
    shutdown: async () => {
      await sdk?.shutdown();
      sdk = undefined;
    }
  });
}

export function safeTelemetryAttributes(input: { operationId: string; route: string; statusCode: number }) {
  return Object.freeze({
    "kavaroutes.operation_id": input.operationId,
    "http.route": input.route,
    "http.response.status_code": input.statusCode
  });
}
