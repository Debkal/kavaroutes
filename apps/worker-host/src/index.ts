import { validateSyntheticJobPayload } from "@kavaroutes/platform-engine/adapters";
import { PgBoss } from "pg-boss";

export interface WorkerHost {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export function createWorkerHost(connectionString: string, onProcessed: (probeId: string) => Promise<void>): WorkerHost {
  const boss = new PgBoss({ connectionString, schema: "wp005_boss", supervise: false });
  let started = false;
  return {
    start: async () => {
      await boss.start();
      await boss.createQueue("wp005-synthetic-probe");
      await boss.work("wp005-synthetic-probe", async ([job]) => {
        if (job === undefined) throw new Error("MISSING_JOB");
        const payload = validateSyntheticJobPayload(job.data);
        await onProcessed(payload.probeId);
      });
      started = true;
    },
    stop: async () => {
      if (started) await boss.stop({ graceful: true, timeout: 5_000 });
      started = false;
    }
  };
}
