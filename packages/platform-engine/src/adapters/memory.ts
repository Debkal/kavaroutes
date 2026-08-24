import type { JobEnrollmentPort, ProbePersistencePort } from "../application/index.js";

export function createMemoryAdapters(): Readonly<{ persistence: ProbePersistencePort; jobs: JobEnrollmentPort }> {
  const ids = new Set<string>();
  return Object.freeze({
    persistence: { save: async (_context, probe) => { ids.add(probe.id); } },
    jobs: {
      enroll: async (_context, probe, idempotencyKey) => {
        if (!ids.has(probe.id)) throw new Error("PROBE_NOT_PERSISTED");
        return `job_${idempotencyKey}`;
      }
    }
  });
}
