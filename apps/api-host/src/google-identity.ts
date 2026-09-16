import { openGoogleIdentity } from '@kavaroutes/google-identity';

/** Explicit composition only; importing this file does not activate a provider. */
export function assertGoogleIdentityRuntime() {
  if (process.env.FIREBASE_AUTH_EMULATOR_HOST !== undefined) {
    throw new Error('GOOGLE_IDENTITY_CONFIGURATION_DENIED');
  }
}

export function openHostGoogleIdentity(authorizeActivation: () => Promise<void>) {
  return openGoogleIdentity({ projectId: 'kavaroutes', authorizeActivation,
    assertRuntimeConfiguration: assertGoogleIdentityRuntime });
}
