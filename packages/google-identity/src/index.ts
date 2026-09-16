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
}): Promise<{ readonly verifyToken: (token: string) => Promise<VerifiedIdentity>; readonly close: () => Promise<void> }> {
  await options.authorizeActivation();
  options.assertRuntimeConfiguration();
  if (options.projectId !== 'kavaroutes') {
    throw new Error('GOOGLE_IDENTITY_CONFIGURATION_DENIED');
  }
  const app = initializeApp({ projectId: options.projectId, credential: applicationDefault() }, `kavaroutes-login-${randomUUID()}`);
  try {
    const verifyToken = createGoogleIdentityVerifier(getAuth(app), options.projectId);
    return Object.freeze({ verifyToken: async (token: string) => {
      // The SDK reads runtime configuration on requests, not only at startup.
      // The host must fail closed if that configuration changes after activation.
      options.assertRuntimeConfiguration();
      return verifyToken(token);
    }, close: () => deleteApp(app) });
  } catch {
    await deleteApp(app);
    throw new Error('GOOGLE_IDENTITY_START_FAILED');
  }
}
