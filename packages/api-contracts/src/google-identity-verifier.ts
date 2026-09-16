import type { VerifiedIdentity } from './identity-admission.js';

/** Adapter boundary for Firebase Admin Auth. This port must be backed by the
 * official Admin SDK in live composition, never an unverified JWT decoder.
 * SDK initialization/credentials and provider activation are separate gates.
 */
export interface GoogleAdminAuth {
  verifyIdToken(token: string, checkRevoked: true): Promise<unknown>;
}
export function createGoogleIdentityVerifier(auth: GoogleAdminAuth, projectId: string) {
  if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(projectId)) throw new Error('GOOGLE_IDENTITY_PROJECT_INVALID');
  const issuer = `https://securetoken.google.com/${projectId}`;
  return async (token: string): Promise<VerifiedIdentity> => {
    try {
      if (typeof token !== 'string' || !token || token.length > 16384 || /\s/.test(token)) throw new Error();
      const raw = await auth.verifyIdToken(token, true);
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error();
      const claims = raw as Record<string, unknown>;
      const provider = claims.firebase;
      if (!provider || typeof provider !== 'object' || Array.isArray(provider)) throw new Error();
      const firebase = provider as Record<string, unknown>;
      // Commercial Enterprise is an application tier, not an implied Identity
      // Platform tenant. Dedicated identity realms require explicit later scope.
      if (firebase.tenant !== undefined || !['password','google.com'].includes(String(firebase.sign_in_provider))) throw new Error();
      if (claims.iss !== issuer || claims.aud !== projectId || typeof claims.sub !== 'string' ||
          claims.sub.length < 1 || claims.sub.length > 128 || claims.uid !== claims.sub ||
          claims.email_verified !== true || !Number.isSafeInteger(claims.exp) || !Number.isSafeInteger(claims.auth_time)) throw new Error();
      return Object.freeze({ issuer, audience: projectId, subject: claims.sub, emailVerified: true,
        expiresAt: claims.exp as number, authenticatedAt: claims.auth_time as number });
    } catch { throw new Error('SIGN_IN_NOT_AUTHORIZED'); }
  };
}
