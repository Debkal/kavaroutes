/** The reviewed provider-side implementation of the revocation sweep's account
 * port, for the `guarded-live` profile.
 *
 * `guarded-provider-revocation.ts` defines what the sweep needs from the provider
 * (account state plus the token-revocation timestamp) and `@kavaroutes/google-identity`
 * already reads both from the Firebase Admin SDK (`getUser` -> `disabled`,
 * `tokensValidAfterTime`). Until now nothing joined the two, so the guarded host
 * could only be composed with a test double.
 *
 * Failure policy, matching `provider-session-revocation.ts`: a provider this host
 * cannot interrogate is reported as `UNKNOWN`, never as `ACTIVE`, so the sweeper's
 * staleness bound and fail-closed revocation decide what happens. A malformed
 * revocation timestamp is a configuration error and is refused rather than
 * silently read as "no revocation".
 */
import type { GuardedProviderAccounts } from './guarded-provider-revocation.js';
import type { ProviderAccountState } from './provider-session-revocation.js';

/** The subset of the provider SDK this adapter needs. */
export interface GuardedProviderIdentityLookup {
  lookupAccount(subject: string): Promise<{ readonly disabled: boolean; readonly revokedAt: string | null }>;
}

export function createGuardedProviderAccounts(identity: GuardedProviderIdentityLookup): GuardedProviderAccounts {
  if (!identity || typeof identity.lookupAccount !== 'function') throw new Error('GUARDED_PROVIDER_ACCOUNTS_INVALID');
  return Object.freeze({
    async checkAccount(subject: string): Promise<ProviderAccountState> {
      try {
        const account = await identity.lookupAccount(subject);
        return account.disabled === true ? 'DISABLED' : 'ACTIVE';
      } catch {
        // Includes provider outages and deadline expiry. Never "still valid".
        return 'UNKNOWN';
      }
    },
    async revokedAt(subject: string): Promise<string | null> {
      const account = await identity.lookupAccount(subject);
      const revokedAt = account.revokedAt;
      if (revokedAt === null || revokedAt === undefined) return null;
      if (typeof revokedAt !== 'string' || !Number.isFinite(Date.parse(revokedAt))) throw new Error('GUARDED_PROVIDER_REVOCATION_TIMESTAMP_INVALID');
      return revokedAt;
    },
  });
}
