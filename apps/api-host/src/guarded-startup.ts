/** Reviewed startup for the `guarded-live` profile.
 *
 * CQ-003 asks this profile to validate "startup config/activation" and CQ-009 has
 * to start it behind the approved edge. Until now nothing constructed
 * `createGuardedApiHost` outside tests, so the composed host could not be started
 * by the image or by the VM at all: the assembly existed, the launcher did not.
 *
 * Every external effect is injected by the process entrypoint (`guarded-main.mjs`),
 * so this module opens nothing by being imported, and two rules are enforced before
 * any resource is touched:
 *
 * - the activation marker must be the reviewed constant, so a host cannot be
 *   switched on by an environment variable someone happened to set;
 * - the configuration must load through `guarded-secrets.ts`, i.e. from a file only
 *   its owner can read, with a bounded base64 signing key.
 *
 * The provider port is not optional: a guarded host that cannot answer "is this
 * account disabled / was this authentication revoked" refuses to compose, so the
 * launcher must supply a real `lookupAccount` implementation and cannot silently
 * fall back to a permissive double.
 */
import type { VerifiedIdentity } from '@kavaroutes/api-contracts/identity-admission';
import { createGuardedApiHost } from './guarded-composition.js';
import { createGuardedProviderAccounts } from './guarded-accounts.js';
import { loadGuardedConfig } from './guarded-secrets.js';

/** Reviewed activation marker; changing it is a reviewed change to this file. */
export const GUARDED_ACTIVATION_MARKER = 'guarded-live/reviewed-activation';

type DatabasePool = Parameters<typeof createGuardedApiHost>[0]['pool'];

export interface GuardedProviderIdentity {
  verifyToken(token: string): Promise<VerifiedIdentity>;
  lookupAccount(subject: string): Promise<{ readonly disabled: boolean; readonly revokedAt: string | null }>;
  close(): Promise<void>;
}

export interface GuardedStartupOptions {
  /** Path of the protected 0600 configuration file. */
  readonly configPath: string;
  /** Must equal `GUARDED_ACTIVATION_MARKER`, or nothing is opened. */
  readonly activation: string;
  /** Human-approved activation hook; awaited before the provider or pool opens. */
  readonly activate: () => Promise<void>;
  readonly openIdentity: () => Promise<GuardedProviderIdentity>;
  readonly createPool: (databaseUrl: string) => DatabasePool;
  readonly now?: () => Date;
  readonly clock?: () => number;
}

export async function startGuardedHost(options: GuardedStartupOptions) {
  if (!options || typeof options.configPath !== 'string' || options.configPath.length < 1 || options.configPath.length > 512) {
    throw new Error('GUARDED_CONFIG_PATH_INVALID');
  }
  if (options.activation !== GUARDED_ACTIVATION_MARKER) throw new Error('GUARDED_ACTIVATION_REQUIRED');
  if (typeof options.activate !== 'function' || typeof options.openIdentity !== 'function' || typeof options.createPool !== 'function') {
    throw new Error('GUARDED_PORTS_INVALID');
  }
  // Read the protected file before the activation hook: a misconfigured host then
  // fails without touching the provider or the database at all.
  const config = await loadGuardedConfig(options.configPath);
  await options.activate();
  const identity = await options.openIdentity();
  let pool: DatabasePool | undefined;
  try {
    pool = options.createPool(config.databaseUrl);
    const host = await createGuardedApiHost({ config, activate: async () => {},
      verifyProviderToken: token => identity.verifyToken(token), providerAccounts: createGuardedProviderAccounts(identity), pool,
      ...(options.now === undefined ? {} : { now: options.now }), ...(options.clock === undefined ? {} : { clock: options.clock }) });
    return Object.freeze({
      app: host.app, config: host.config, gateway: host.gateway, revocation: host.revocation, origin: host.origin,
      start: () => host.start(),
      /** Closes the host, the provider session and the pool, in that order. */
      async shutdown() {
        await host.close();
        await identity.close();
        await endPool(pool);
      },
    });
  } catch (error) {
    // A host that could not compose must not leave a provider session or a pool
    // open behind it. The original error code is what the caller reports.
    await identity.close().catch(() => {});
    await endPool(pool);
    throw error;
  }
}

async function endPool(pool: DatabasePool | undefined): Promise<void> {
  const end = (pool as { end?: () => Promise<void> } | undefined)?.end;
  if (typeof end === 'function') await end.call(pool).catch(() => {});
}
