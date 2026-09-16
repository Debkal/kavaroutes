import { applicationDefault, deleteApp, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { randomUUID } from 'node:crypto';
import { createGoogleIdentityVerifier } from '@kavaroutes/api-contracts/google-identity-verifier';
import type { VerifiedIdentity } from '@kavaroutes/api-contracts/identity-admission';

/** Server-only SDK composition. Caller must enforce reviewed activation before
 * invoking this factory. No default app, environment-selected project or keys.
 */
export async function openGoogleIdentity(options: {
  readonly projectId: string;
  readonly authorizeActivation: () => Promise<void>;
  readonly assertRuntimeConfiguration: () => void;
}): Promise<{
  readonly verifyToken: (token: string) => Promise<VerifiedIdentity>;
  /** Provider account state for revocation sweeps: `accounts:lookup` returns
   * whether the account is disabled and the timestamp after which previously
   * issued tokens are invalid. The caller must still compare that timestamp with
   * the application session's own authentication time — an enabled account is
   * not proof that an existing session is still valid. */
  readonly lookupAccount: (subject: string) => Promise<{ readonly disabled: boolean; readonly revokedAt: string | null }>;
  readonly close: () => Promise<void>;
}> {
  await options.authorizeActivation();
  options.assertRuntimeConfiguration();
  if (options.projectId !== 'kavaroutes') {
    throw new Error('GOOGLE_IDENTITY_CONFIGURATION_DENIED');
  }
  const app = initializeApp({ projectId: options.projectId, credential: applicationDefault() }, `kavaroutes-login-${randomUUID()}`);
  try {
    const verifyToken = createGoogleIdentityVerifier(getAuth(app), options.projectId);
    const assertRuntime = () => options.assertRuntimeConfiguration();
    return Object.freeze({ lookupAccount: async (subject: string) => {
      assertRuntime();
      if (typeof subject !== 'string' || subject.length < 1 || subject.length > 128) throw new Error('GOOGLE_IDENTITY_SUBJECT_INVALID');
      const user = await getAuth(app).getUser(subject);
      return Object.freeze({ disabled: user.disabled === true, revokedAt: user.tokensValidAfterTime ?? null });
    }, verifyToken: async (token: string) => {
      // The SDK reads runtime configuration on requests, not only at startup.
      // The host must fail closed if that configuration changes after activation.
      assertRuntime();
      return verifyToken(token);
    }, close: () => deleteApp(app) });
  } catch {
    await deleteApp(app);
    throw new Error('GOOGLE_IDENTITY_START_FAILED');
  }
}
