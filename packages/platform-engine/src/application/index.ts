import type { RequestContext } from "@kavaroutes/shared-kernel";
import { acceptSyntheticProbe, type SyntheticProbe } from "../domain/index.js";

export interface ProbePersistencePort {
  save(context: RequestContext, probe: SyntheticProbe): Promise<void>;
}

export interface JobEnrollmentPort {
  enroll(context: RequestContext, probe: SyntheticProbe, idempotencyKey: string): Promise<string>;
}

export interface ProbeDependencies {
  readonly persistence: ProbePersistencePort;
  readonly jobs: JobEnrollmentPort;
}

export interface SubmitSyntheticProbe {
  readonly probeId: string;
  readonly input: "alpha" | "bravo";
  readonly idempotencyKey: string;
}

export function createSubmitSyntheticProbe(dependencies: ProbeDependencies) {
  return async (context: RequestContext, command: SubmitSyntheticProbe): Promise<Readonly<{ probe: SyntheticProbe; jobId: string }>> => {
    const probe = acceptSyntheticProbe(command.probeId, command.input);
    await dependencies.persistence.save(context, probe);
    const jobId = await dependencies.jobs.enroll(context, probe, command.idempotencyKey);
    return Object.freeze({ probe, jobId });
  };
}
