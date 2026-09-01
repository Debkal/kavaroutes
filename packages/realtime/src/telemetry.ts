export type RealtimeMetric = "upgrade" | "connection" | "subscription" | "authorization" | "replay" | "reset" | "gap" | "fanout" | "reconnect" | "sync_age" | "freshness" | "buffer" | "slow_client" | "heartbeat" | "notification" | "poll" | "coalescing" | "resource" | "fairness" | "transport_failure" | "store_failure" | "dependency_failure";

export interface RealtimeTelemetryEvent {
  readonly metric: RealtimeMetric;
  readonly outcome: "accepted" | "rejected" | "success" | "reset" | "closed" | "missed";
  readonly clientClass?: "synthetic-web" | "synthetic-native";
  readonly streamKind?: "dispatch" | "manifest" | "facility" | "operation" | "position";
  readonly value?: number;
}

const prohibited = /token|cursor|authorization|cookie|tenant|organization|principal|driver|trip|facility|latitude|longitude|payload|scope|resource|address|name|phone|email|secret|coordinate/i;

export function safeRealtimeTelemetry(event: RealtimeTelemetryEvent): Readonly<Record<string, string | number>> {
  const record = Object.fromEntries(Object.entries(event).filter(([, value]) => value !== undefined));
  for (const [key, value] of Object.entries(record)) {
    if (prohibited.test(key) || (typeof value === "string" && prohibited.test(value) && key !== "metric")) throw new Error("REALTIME_TELEMETRY_DISCLOSURE");
  }
  return Object.freeze(record as Record<string, string | number>);
}

export function createRealtimeMetrics() {
  const events: Readonly<Record<string, string | number>>[] = [];
  return Object.freeze({
    record(event: RealtimeTelemetryEvent) { events.push(safeRealtimeTelemetry(event)); },
    events: () => Object.freeze([...events]),
  });
}
