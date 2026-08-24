import { PgBoss } from "pg-boss";
import type { JobEnrollmentPort } from "../application/index.js";

export interface SyntheticJobPayload {
  readonly probeId: string;
  readonly operationId: string;
}

export function validateSyntheticJobPayload(value: unknown): SyntheticJobPayload {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("INVALID_JOB_PAYLOAD");
  const candidate = value as Record<string, unknown>;
  if (Object.keys(candidate).sort().join(",") !== "operationId,probeId") throw new Error("INVALID_JOB_PAYLOAD");
  if (typeof candidate.probeId !== "string" || !/^probe_[a-z0-9]{8}$/.test(candidate.probeId)) throw new Error("INVALID_JOB_PAYLOAD");
  if (typeof candidate.operationId !== "string" || !/^[a-z0-9][a-z0-9_-]{2,63}$/.test(candidate.operationId)) throw new Error("INVALID_JOB_PAYLOAD");
  return Object.freeze({ probeId: candidate.probeId, operationId: candidate.operationId });
}

export function createPgBossAdapter(boss: PgBoss): JobEnrollmentPort {
  return {
    enroll: async (context, probe, idempotencyKey) => {
      if (!/^[a-z0-9][a-z0-9_-]{2,63}$/.test(idempotencyKey)) throw new Error("INVALID_IDEMPOTENCY_KEY");
      const payload = validateSyntheticJobPayload({ probeId: probe.id, operationId: context.operationId });
      const jobId = await boss.send("wp005-synthetic-probe", payload, {
        singletonKey: idempotencyKey,
        singletonSeconds: 86_400,
        retryLimit: 2
      });
      if (jobId === null) return `duplicate_${idempotencyKey}`;
      return jobId;
    }
  };
}
