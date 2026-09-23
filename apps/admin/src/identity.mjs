import { createRemoteJWKSet, jwtVerify } from 'jose';

export function identityVerifier(config, { jwks } = {}) {
  if (config.mode === 'local') return async (_request, email) => ({ email, subject: `local:${email}` });
  const keys = jwks ?? createRemoteJWKSet(new URL(`${config.accessIssuer}/cdn-cgi/access/certs`), { timeoutDuration: 5000 });
  return async request => {
    const jwt = request.headers['cf-access-jwt-assertion'];
    if (typeof jwt !== 'string' || jwt.length > 16384) throw new Error('IDENTITY_REQUIRED');
    const { payload } = await jwtVerify(jwt, keys, {
      issuer: config.accessIssuer, audience: config.accessAudience, algorithms: ['RS256'],
      requiredClaims: ['exp','iat','sub','email'],
    });
    if (typeof payload.email !== 'string' || typeof payload.sub !== 'string' || !payload.sub) throw new Error('IDENTITY_REQUIRED');
    return { email: payload.email.toLowerCase(), subject: payload.sub };
  };
}
