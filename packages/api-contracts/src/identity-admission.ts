/** Server-only admission policy. Not a JWT verifier, session issuer, or login route.
 * The provider port must verify signature, issuer, audience and revocation before
 * returning claims. Never implement it as an unverified JWT decode.
 */
export interface VerifiedIdentity {
  readonly issuer: string;
  readonly audience: string;
  readonly subject: string;
  readonly emailVerified: boolean;
  readonly expiresAt: number;
  readonly authenticatedAt: number;
}
export interface IdentityMembership {
  readonly userId: string;
  readonly principalId: string;
  readonly organizationId: string;
  readonly identityIssuer: string;
  readonly identitySubject: string;
  readonly userActive: boolean;
  readonly membershipActive: boolean;
  readonly authorizationGeneration: number;
}
export interface IdentityAdmissionPorts {
  verifyToken(token: string): Promise<VerifiedIdentity>;
  // A read-only database lookup; no signup, email matching or implicit linking.
  findMembership(issuer: string, subject: string, organizationId: string): Promise<IdentityMembership | null>;
}
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
export class IdentityAdmissionError extends Error {
  constructor() { super('SIGN_IN_NOT_AUTHORIZED'); this.name = 'IdentityAdmissionError'; }
}
export function createIdentityAdmission(ports: IdentityAdmissionPorts, options: {
  readonly issuer: string; readonly audience: string; readonly now: () => number;
  readonly maximumAuthenticationAgeSeconds: number;
}) {
  const issuer = new URL(options.issuer);
  if (issuer.protocol !== 'https:' || issuer.username || issuer.password || issuer.search || issuer.hash ||
      !options.audience || !Number.isSafeInteger(options.maximumAuthenticationAgeSeconds) ||
      options.maximumAuthenticationAgeSeconds < 1 || options.maximumAuthenticationAgeSeconds > 3600) {
    throw new Error('IDENTITY_ADMISSION_CONFIGURATION_INVALID');
  }
  return Object.freeze({
    async admit(token: string, organizationId: string) {
      try {
        if (typeof token !== 'string' || token.length < 1 || token.length > 16384 || /\s/.test(token) || !uuid.test(organizationId)) throw new IdentityAdmissionError();
        const identity = await ports.verifyToken(token);
        const now = options.now();
        if (!Number.isSafeInteger(now) || identity.issuer !== options.issuer || identity.audience !== options.audience ||
            typeof identity.subject !== 'string' || identity.subject.length < 1 || identity.subject.length > 128 ||
            identity.emailVerified !== true || !Number.isSafeInteger(identity.expiresAt) || identity.expiresAt <= now ||
            !Number.isSafeInteger(identity.authenticatedAt) || identity.authenticatedAt > now ||
            now - identity.authenticatedAt > options.maximumAuthenticationAgeSeconds) throw new IdentityAdmissionError();
        const membership = await ports.findMembership(identity.issuer, identity.subject, organizationId);
        if (!membership || membership.identityIssuer !== identity.issuer || membership.identitySubject !== identity.subject ||
            membership.organizationId !== organizationId || !uuid.test(membership.userId) || !uuid.test(membership.principalId) ||
            membership.userActive !== true || membership.membershipActive !== true ||
            !Number.isSafeInteger(membership.authorizationGeneration) || membership.authorizationGeneration < 1) throw new IdentityAdmissionError();
        // No provider token, email, tier or client-supplied capability is returned.
        // Session creation must atomically recheck this generation and membership.
        return Object.freeze({ userId: membership.userId, principalId: membership.principalId,
          organizationId: membership.organizationId, authorizationGeneration: membership.authorizationGeneration,
          issuer: identity.issuer, subject: identity.subject });
      } catch { throw new IdentityAdmissionError(); }
    },
  });
}
