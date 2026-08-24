import type { FailureClass } from "./policies.js";
import { JOB_TYPES, type OutboxRoute } from "./contracts.js";

export interface DurableTelemetryEvent {
  readonly name: "outbox.claim" | "outbox.publish" | "consumer.apply" | "consumer.duplicate" | "consumer.gap" | "replay.change" | "effect.outcome";
  readonly route: OutboxRoute;
  readonly jobType: string;
  readonly status: "SUCCESS" | "RETRY" | "BLOCKED" | "DEAD_LETTER" | "DUPLICATE" | "GAP" | "MANUAL_REVIEW";
  readonly failureClass?: FailureClass;
  readonly handlerVersion: string;
  readonly environment: "LOCAL" | "TEST";
  readonly durationMs: number;
}

export function safeTelemetry(event: DurableTelemetryEvent): Readonly<Record<string, string | number>> {
  if (!JOB_TYPES[event.route].includes(event.jobType) || !/^v[1-9][0-9]*$/.test(event.handlerVersion) || !Number.isFinite(event.durationMs) || event.durationMs < 0) throw new Error("UNSAFE_TELEMETRY");
  return Object.freeze({ name: event.name, route: event.route, job_type: event.jobType, status: event.status,
    ...(event.failureClass ? { failure_class: event.failureClass } : {}), handler_version: event.handlerVersion,
    environment: event.environment, duration_ms: Math.floor(event.durationMs) });
}
