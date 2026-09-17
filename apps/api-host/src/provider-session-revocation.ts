/** Bounded provider-account revocation propagation for the guarded profile.
 *
 * SDK validation at login is not enough: an account disabled at the provider —
 * or an authentication the provider has revoked since the session was created —
 * must lose its existing application sessions, and an unreachable provider must
 * never be silently read as "still valid".
 *
 * Policy implemented here (see `cloud_findings.md` for the availability/security
 * tradeoff that still needs human/auditor acceptance):
 *
 * - provider reports DISABLED            -> that subject's sessions are revoked now;
 * - provider reports a revocation at or after a session's authentication time
 *   (`validSince`)                        -> that subject's older sessions are revoked;
 * - provider UNKNOWN / timeout / listing failure -> the sweeper reports DEGRADED
 *   while the outage is shorter than `maximumStalenessMilliseconds`;
 * - outage longer than that bound        -> every active session is revoked
 *   (fail closed) and the sweeper reports FAILED_CLOSED until the provider
 *   answers again. The durable marker is set only after `revokeAllActive()`
 *   actually succeeds, so a failed or timed-out mass revocation is retried on
 *   the next sweep while admission stays denied;
 * - provider answers again               -> the outage clears and the sweeper
 *   reports CURRENT.
 *
 * Admission is gated as well, not reported only: `authorize` refuses a request
 * whose provider evidence is missing, stale beyond the bound or fail-closed, and
 * performs one bounded inline check before refusing. A process restart drops the
 * in-memory evidence and the outage clock, so the first request per subject after
 * a restart is checked inline and refused if the provider cannot answer.
 *
 * Every provider call is deadline-bounded, and the sweep is a fair resumable
 * traversal: with a stable subject order and `N` active subjects, a full pass
 * visits every subject in `ceil(N/batchSize)` sweeps, so no subject goes
 * unchecked for longer than `ceil(N/batchSize) x sweepInterval + deadline`.
 *
 * The ports are injected, so no database or provider dependency is implied here.
 * The live reader must be a bounded, tenant-scoped traversal equivalent to
 * `platform.enrolled_tenants(integer)`; it must not scan tenants with an
 * unrestricted query.
 */
export type ProviderAccountState = 'ACTIVE' | 'DISABLED' | 'UNKNOWN';
export type ProviderRevocationState = 'CURRENT' | 'DEGRADED' | 'FAILED_CLOSED';
export type ProviderRevocationReason =
  | 'PROVIDER_ACTIVE'
  | 'PROVIDER_ACCOUNT_DISABLED'
  | 'PROVIDER_AUTHENTICATION_REVOKED'
  | 'PROVIDER_UNVERIFIED'
  | 'PROVIDER_FAILED_CLOSED'
  | 'PROVIDER_CHECK_TIMEOUT';
export type ProviderAuthorization =
  | { readonly allowed: true; readonly reason: 'PROVIDER_ACTIVE'; readonly checkedAt: number }
  | { readonly allowed: false; readonly reason: ProviderRevocationReason; readonly checkedAt: number | null;
      readonly retryAfterSeconds?: number };

export interface ProviderRevocationPorts {
  /** One bounded page of currently active subjects, strictly ordered by the
   * opaque subject reference. `after` resumes a pass; `null` starts one. */
  listActiveSubjects(limit: number, after?: string | null): Promise<readonly string[]>;
  /** Provider account state. An enabled account is not proof of unrevoked
   * authentication, so callers must also consult `providerRevokedAt`. */
  checkAccount(subject: string): Promise<ProviderAccountState>;
  /** Provider token-revocation timestamp (`validSince`) for the subject, or
   * `null` when the provider reports none. Required: without it an enabled
   * account would be equated with unrevoked authentication. */
  providerRevokedAt(subject: string): Promise<string | null>;
  /** Revokes the subject's sessions that predate `revokedAt` (`null` = all
   * active sessions) and reports how many were revoked. */
  revokeSubject(subject: string, revokedAt: string | null): Promise<number>;
  /** Fail-closed sweep: revokes every active session exactly once per outage. */
  revokeAllActive(): Promise<number>;
}

interface LedgerEntry {
  readonly state: ProviderAccountState;
  readonly revokedAt: string | null;
  readonly checkedAt: number;
}

export function createProviderRevocationSweeper(ports: ProviderRevocationPorts, options: {
  readonly maximumStalenessMilliseconds: number;
  readonly batchSize?: number;
  readonly checkDeadlineMilliseconds?: number;
  readonly now?: () => number;
}) {
  if (!Number.isSafeInteger(options.maximumStalenessMilliseconds) || options.maximumStalenessMilliseconds < 60_000 ||
      options.maximumStalenessMilliseconds > 86_400_000) throw new Error('PROVIDER_REVOCATION_CONFIG_INVALID');
  const batchSize = options.batchSize ?? 50;
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 500) throw new Error('PROVIDER_REVOCATION_CONFIG_INVALID');
  const checkDeadlineMilliseconds = options.checkDeadlineMilliseconds ?? 2_000;
  if (!Number.isInteger(checkDeadlineMilliseconds) || checkDeadlineMilliseconds < 50 || checkDeadlineMilliseconds > 30_000) {
    throw new Error('PROVIDER_REVOCATION_CONFIG_INVALID');
  }
  // Fail closed on an incomplete port set: a viewer that cannot distinguish
  // "enabled" from "unrevoked authentication" must not be composed at all.
  for (const port of ['listActiveSubjects', 'checkAccount', 'providerRevokedAt', 'revokeSubject', 'revokeAllActive']) {
    if (typeof (ports as unknown as Record<string, unknown>)[port] !== 'function') throw new Error('PROVIDER_REVOCATION_PORT_INCOMPLETE');
  }
  const now = options.now ?? (() => Date.now());
  let outageStartedAt: number | null = null;
  let failClosedActive = false;
  let durableRevocationRecorded = false;
  let cursor: string | null = null;
  let lastSweepAt: number | null = null;
  let passes = 0;
  let sweeps = 0;
  const ledger = new Map<string, LedgerEntry>();

  return Object.freeze({
    async runOnce() {
      sweeps += 1;
      lastSweepAt = now();
      let subjects: readonly string[];
      try {
        const listed = await deadline(ports.listActiveSubjects(batchSize, cursor), checkDeadlineMilliseconds, 'listing');
        if (!Array.isArray(listed) || listed.length > batchSize || listed.some(subject => typeof subject !== 'string')) {
          return record(true, false, 0, 0, 0, 1);
        }
        subjects = listed;
      } catch {
        return record(true, false, 0, 0, 0, 1);
      }
      // A short page ends the pass; the next sweep restarts from the beginning
      // so every subject is revisited rather than the head of the list only.
      cursor = subjects.length === batchSize ? (subjects[subjects.length - 1] ?? null) : null;
      if (cursor === null) passes += 1;
      let revoked = 0;
      let unknown = 0;
      for (const subject of subjects) {
        const observation = await observe(subject);
        if (observation === null) { unknown += 1; continue; }
        if (observation.state === 'DISABLED') {
          revoked += await revokeSub(subject, null);
        } else if (observation.revokedAt !== null) {
          revoked += await revokeSub(subject, observation.revokedAt);
        } else if (observation.state !== 'ACTIVE') {
          unknown += 1;
        }
      }
      return record(unknown > 0, true, subjects.length, subjects.length, revoked, unknown);
    },
    /** Admission decision for one subject at one session authentication time. */
    async authorize(input: { readonly subject: string; readonly sessionAuthenticatedAt: string | null }) {
      if (typeof input.subject !== 'string' || input.subject.length < 1 || input.subject.length > 128) {
        return denial('PROVIDER_UNVERIFIED', null, checkDeadlineMilliseconds);
      }
      const cached = ledger.get(input.subject);
      if (cached && now() - cached.checkedAt <= options.maximumStalenessMilliseconds) return decide(cached, input.sessionAuthenticatedAt);
      if (failClosedActive) return denial('PROVIDER_FAILED_CLOSED', null, checkDeadlineMilliseconds);
      // No fresh evidence: the provider is authoritative for this request. One
      // bounded inline check, then refuse rather than trust a stale session.
      const observation = await observe(input.subject);
      if (observation === null) return denial('PROVIDER_UNVERIFIED', null, checkDeadlineMilliseconds);
      return decide(observation, input.sessionAuthenticatedAt);
    },
    status() {
      return Object.freeze({ state: stateFor(), outageStartedAt, failClosedActive, durableRevocationRecorded,
        durableRevocationPending: failClosedActive && !durableRevocationRecorded, cursor, passes, sweeps, lastSweepAt,
        subjectsWithFreshEvidence: ledger.size });
    },
    /** Evidence currently held for one subject; `null` means never observed. */
    evidence(subject: string) {
      const entry = ledger.get(subject);
      return entry ? Object.freeze({ ...entry }) : null;
    },
  });

  function stateFor(): ProviderRevocationState {
    if (outageStartedAt === null) return 'CURRENT';
    return failClosedActive ? 'FAILED_CLOSED' : 'DEGRADED';
  }
  function decide(entry: LedgerEntry, sessionAuthenticatedAt: string | null): ProviderAuthorization {
    if (entry.state === 'DISABLED') return denial('PROVIDER_ACCOUNT_DISABLED', entry.checkedAt);
    if (entry.state !== 'ACTIVE') return denial('PROVIDER_UNVERIFIED', entry.checkedAt, checkDeadlineMilliseconds);
    if (entry.revokedAt === null) return Object.freeze({ allowed: true, reason: 'PROVIDER_ACTIVE', checkedAt: entry.checkedAt });
    const revocationSecond = secondOf(entry.revokedAt);
    const authenticationSecond = sessionAuthenticatedAt === null ? null : secondOf(sessionAuthenticatedAt);
    // `validSince` is second-granular, so a session authenticated in the same
    // second as the revocation is ambiguous and is refused.
    if (authenticationSecond === null || revocationSecond === null) return denial('PROVIDER_AUTHENTICATION_REVOKED', entry.checkedAt);
    if (revocationSecond >= authenticationSecond) return denial('PROVIDER_AUTHENTICATION_REVOKED', entry.checkedAt);
    return Object.freeze({ allowed: true, reason: 'PROVIDER_ACTIVE', checkedAt: entry.checkedAt });
  }
  function denial(reason: ProviderRevocationReason, checkedAt: number | null, retryAfter?: number): ProviderAuthorization {
    return Object.freeze({ allowed: false, reason, checkedAt,
      ...(retryAfter === undefined ? {} : { retryAfterSeconds: Math.max(1, Math.ceil(retryAfter / 1000)) }) });
  }
  /** One deadline-bounded provider observation; `null` means "no evidence". */
  async function observe(subject: string): Promise<LedgerEntry | null> {
    let state: ProviderAccountState;
    let revokedAt: string | null;
    try {
      state = await deadline(ports.checkAccount(subject), checkDeadlineMilliseconds, 'account');
      if (state !== 'ACTIVE' && state !== 'DISABLED') throw new Error('PROVIDER_ACCOUNT_STATE_UNKNOWN');
      revokedAt = state === 'ACTIVE' ? await deadline(ports.providerRevokedAt(subject), checkDeadlineMilliseconds, 'revocation') : null;
      if (revokedAt !== null && !Number.isFinite(Date.parse(revokedAt))) throw new Error('PROVIDER_REVOCATION_TIMESTAMP_INVALID');
    } catch {
      // Awaited: a concurrent, unawaited failure path could otherwise observe
      // the fail-closed state twice and mass-revoke more than once per outage.
      await record(true, false, 0, 0, 0, 1);
      return null;
    }
    // A successful observation is evidence the provider answered: the outage
    // window clears so a recovered provider cannot stay fail-closed.
    record(false, false, 0, 0, 0, 0);
    const entry: LedgerEntry = Object.freeze({ state, revokedAt, checkedAt: now() });
    ledger.set(subject, entry);
    return entry;
  }
  async function revokeSub(subject: string, revokedAt: string | null): Promise<number> {
    try { return await deadline(ports.revokeSubject(subject, revokedAt), checkDeadlineMilliseconds, 'revoke'); }
    catch { await record(true, false, 0, 0, 0, 1); return 0; }
  }
  async function record(outage: boolean, listed: boolean, checked: number, listedCount: number, revoked: number, unknown: number) {
    const timestamp = now();
    if (!outage) {
      outageStartedAt = null;
      failClosedActive = false;
      // The provider answered, so the previous outage's durable fail-closed
      // revocation is complete for this outage; a later outage starts a new one.
      durableRevocationRecorded = false;
      return result(checked, listedCount, revoked, unknown);
    }
    outageStartedAt ??= timestamp;
    if (timestamp - outageStartedAt >= options.maximumStalenessMilliseconds) {
      // Admission is denied for the whole expired-outage window, whether or not
      // the durable revocation has been persisted yet.
      failClosedActive = true;
      // Persist the fail-closed transition once per outage: the durable marker
      // moves only after `revokeAllActive()` actually succeeds, so a rejected or
      // timed-out mass revocation stays pending and is retried by the next sweep,
      // while a success is never repeated inside the same outage.
      if (!durableRevocationRecorded) {
        try {
          revoked += await deadline(ports.revokeAllActive(), checkDeadlineMilliseconds, 'revoke-all');
          durableRevocationRecorded = true;
        } catch { /* retried on the next sweep; admission stays denied meanwhile */ }
      }
    }
    if (!listed) return result(0, 0, revoked, unknown);
    return result(checked, listedCount, revoked, unknown);
  }
  function result(checked: number, listed: number, revoked: number, unknown: number) {
    return Object.freeze({ checked, listed, revoked, unknown, state: stateFor() });
  }
}

/** Second-truncated epoch milliseconds, matching the provider's `validSince`
 * granularity. `null` for an unparseable timestamp so the caller can fail closed. */
function secondOf(timestamp: string): number | null {
  const parsed = Date.parse(timestamp);
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) * 1000 : null;
}

/** Bounded provider call: a hanging provider must not hold a request or a sweep. */
async function deadline<T>(work: Promise<T>, milliseconds: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`PROVIDER_${label.toUpperCase()}_TIMEOUT`)), milliseconds);
      timer.unref?.();
    })]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
