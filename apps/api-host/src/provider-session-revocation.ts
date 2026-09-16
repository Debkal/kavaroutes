/** Bounded provider-account revocation propagation for the guarded profile.
 *
 * SDK validation at login is not enough: an account disabled at the provider must
 * lose its existing application sessions. The policy below is deliberately bounded
 * so a provider outage cannot be mistaken for a revocation wave, and cannot leave
 * sessions permanently unverified either:
 *
 * - provider reports DISABLED  -> that subject's active sessions are revoked at once;
 * - provider reports UNKNOWN (or throws) -> nothing is revoked while the outage is
 *   shorter than `maximumStalenessMilliseconds`; the sweeper reports DEGRADED;
 * - the outage lasts longer than `maximumStalenessMilliseconds` -> every active
 *   session is revoked exactly once (fail closed) and the sweeper reports
 *   FAILED_CLOSED until the provider answers again;
 * - provider recovers -> the outage window clears and the sweeper reports CURRENT.
 *
 * The ports are injected, so no database or provider dependency is implied here.
 * The live port must be a bounded, tenant-scoped reader equivalent to
 * `platform.enrolled_tenants(integer)`; it must not scan tenants with an
 * unrestricted query.
 */
export type ProviderAccountState = 'ACTIVE' | 'DISABLED' | 'UNKNOWN';
export type ProviderRevocationState = 'CURRENT' | 'DEGRADED' | 'FAILED_CLOSED';

export interface ProviderRevocationPorts {
  /** Bounded batch of currently active subjects, newest resolution first. */
  listActiveSubjects(limit: number): Promise<readonly string[]>;
  checkAccount(subject: string): Promise<ProviderAccountState>;
  revokeSubject(subject: string): Promise<number>;
  revokeAllActive(): Promise<number>;
}

export function createProviderRevocationSweeper(ports: ProviderRevocationPorts, options: {
  readonly maximumStalenessMilliseconds: number;
  readonly batchSize?: number;
  readonly now?: () => number;
}) {
  if (!Number.isSafeInteger(options.maximumStalenessMilliseconds) || options.maximumStalenessMilliseconds < 60_000 ||
      options.maximumStalenessMilliseconds > 86_400_000) throw new Error('PROVIDER_REVOCATION_CONFIG_INVALID');
  const batchSize = options.batchSize ?? 50;
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 500) throw new Error('PROVIDER_REVOCATION_CONFIG_INVALID');
  const now = options.now ?? (() => Date.now());
  let outageStartedAt: number | null = null;
  let failedClosed = false;
  return Object.freeze({
    async runOnce() {
      let subjects: readonly string[];
      try {
        subjects = await ports.listActiveSubjects(batchSize);
        if (!Array.isArray(subjects) || subjects.length > batchSize) throw new Error('PROVIDER_REVOCATION_BOUNDS');
      } catch { return record(true, 0, 0, 0); }
      let revoked = 0;
      let unknown = 0;
      for (const subject of subjects) {
        if (typeof subject !== 'string' || subject.length < 1 || subject.length > 128) { unknown += 1; continue; }
        let state: ProviderAccountState;
        try { state = await ports.checkAccount(subject); } catch { state = 'UNKNOWN'; }
        if (state === 'DISABLED') revoked += await ports.revokeSubject(subject);
        else if (state !== 'ACTIVE') unknown += 1;
      }
      return record(unknown > 0, subjects.length, subjects.length, revoked, unknown);
    },
    status() {
      return Object.freeze({ state: stateFor(), outageStartedAt, failedClosed });
    },
  });

  function stateFor(): ProviderRevocationState {
    if (outageStartedAt === null) return 'CURRENT';
    return failedClosed ? 'FAILED_CLOSED' : 'DEGRADED';
  }
  async function record(outage: boolean, checked: number, listed: number, revoked: number, unknown = 0) {
    const timestamp = now();
    if (!outage) { outageStartedAt = null; failedClosed = false; return result(checked, listed, revoked, unknown); }
    outageStartedAt ??= timestamp;
    if (!failedClosed && timestamp - outageStartedAt >= options.maximumStalenessMilliseconds) {
      revoked += await ports.revokeAllActive();
      failedClosed = true;
    }
    return result(checked, listed, revoked, unknown);
  }
  function result(checked: number, listed: number, revoked: number, unknown: number) {
    return Object.freeze({ checked, listed, revoked, unknown, state: stateFor() });
  }
}
