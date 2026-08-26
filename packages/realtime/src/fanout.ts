import type { RealtimeTelemetryEvent } from "./telemetry.js";

export const REALTIME_NOTIFICATION_CHANNEL = "kavaroutes_realtime" as const;

export interface RealtimeWakeSource {
  start(onWake: (payload: string) => void): Promise<void>;
  stop(): Promise<void>;
  queueUsage(): Promise<number>;
}

export function createNotificationPollFanout(options: {
  readonly wakeSource: RealtimeWakeSource;
  readonly fanOut: () => Promise<number>;
  readonly pollMilliseconds?: number;
  readonly telemetrySink?: (event: RealtimeTelemetryEvent) => void;
}) {
  let timer: NodeJS.Timeout | null = null;
  let running = false;
  let pending = false;
  const pollMilliseconds = options.pollMilliseconds ?? 1_000;

  async function run(reason: "notification" | "poll"): Promise<void> {
    if (running) { pending = true; return; }
    running = true;
    try {
      do { pending = false; await options.fanOut(); } while (pending);
      options.telemetrySink?.({ metric: reason, outcome: "success" });
    } finally { running = false; }
  }

  return Object.freeze({
    async start() {
      await options.wakeSource.start((payload) => { if (payload !== "") throw new Error("REALTIME_NOTIFICATION_PAYLOAD_PROHIBITED"); void run("notification"); });
      await run("poll");
      timer = setInterval(() => { void run("poll"); }, pollMilliseconds);
      timer.unref();
    },
    async stop() { if (timer) clearInterval(timer); timer = null; await options.wakeSource.stop(); },
    poll: () => run("poll"),
    queueUsage: () => options.wakeSource.queueUsage(),
  });
}
