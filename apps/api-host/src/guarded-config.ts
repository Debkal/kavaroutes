/** Reviewed `guarded-live` composition configuration.
 *
 * Deliberately separate from the private synthetic runtime profile in
 * `infra/gcp/runtime/config.mjs`: that profile keeps its own rules and is never
 * loosened to accommodate this one. Nothing here activates a provider, exposes
 * public ingress or accepts a synthetic/Bearer principal.
 */
const secretPattern = /^[A-Za-z0-9_-]{43,}$/;
const projectPattern = /^[a-z][a-z0-9-]{2,61}$/;
const issuerPrefix = 'https://securetoken.google.com/';
const issuerPattern = /^https:\/\/securetoken\.google\.com\/[a-z][a-z0-9-]{2,61}$/;

export const GUARDED_CONFIG_KEYS = Object.freeze(['profile', 'origin', 'host', 'port', 'databaseUrl', 'etagSecret',
  'cursorSecret', 'signingKey', 'issuer', 'audience', 'maximumAuthenticationAgeSeconds', 'trustedProxyHops'] as const);

export interface GuardedRuntimeConfig {
  readonly profile: 'guarded-live';
  readonly origin: string;
  readonly host: '127.0.0.1' | '::1';
  readonly port: number;
  readonly databaseUrl: string;
  readonly etagSecret: string;
  readonly cursorSecret: string;
  readonly signingKey: Buffer;
  readonly issuer: string;
  readonly audience: string;
  readonly maximumAuthenticationAgeSeconds: number;
  /** 0 = no proxy in front of the loopback listener; 1 = a trusted TLS edge on
   * the same host that must present x-forwarded-proto=https. */
  readonly trustedProxyHops: 0 | 1;
}

function invalid(code: string): never {
  throw new Error(code);
}

export function validateGuardedConfig(input: unknown): GuardedRuntimeConfig {
  if (!input || typeof input !== 'object' || Array.isArray(input)) invalid('GUARDED_CONFIG_INVALID');
  const value = input as Record<string, unknown>;
  if (Object.keys(value).sort().join(',') !== [...GUARDED_CONFIG_KEYS].sort().join(',')) invalid('GUARDED_CONFIG_KEYS_INVALID');
  if (value.profile !== 'guarded-live') invalid('GUARDED_PROFILE_INVALID');

  const origin = value.origin;
  if (typeof origin !== 'string' || origin.length > 128 || origin.includes('*')) invalid('GUARDED_ORIGIN_INVALID');
  let originUrl: URL;
  try { originUrl = new URL(origin); } catch { return invalid('GUARDED_ORIGIN_INVALID'); }
  if (originUrl.protocol !== 'https:' || originUrl.origin !== origin) invalid('GUARDED_ORIGIN_INVALID');

  const host = value.host;
  if (host !== '127.0.0.1' && host !== '::1') invalid('GUARDED_LISTENER_INVALID');
  const port = value.port;
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1024 || port > 65535) invalid('GUARDED_LISTENER_INVALID');

  const databaseUrl = value.databaseUrl;
  if (typeof databaseUrl !== 'string') invalid('GUARDED_DATABASE_INVALID');
  let database: URL;
  try { database = new URL(databaseUrl); } catch { return invalid('GUARDED_DATABASE_INVALID'); }
  if (database.protocol !== 'postgresql:' || database.hostname !== '127.0.0.1' || database.pathname !== '/kavaroutes_cloud' ||
      database.search !== '' || database.hash !== '' || database.password === '' || database.username !== 'kr_cloud_api') invalid('GUARDED_DATABASE_INVALID');

  const etagSecret = value.etagSecret;
  const cursorSecret = value.cursorSecret;
  for (const secret of [etagSecret, cursorSecret]) {
    // A synthetic-marked secret is always refused here, whatever its shape.
    if (typeof secret !== 'string' || !secretPattern.test(secret) || secret.startsWith('synthetic-')) invalid('GUARDED_SECRET_INVALID');
  }

  const signingKey = value.signingKey;
  if (!Buffer.isBuffer(signingKey) || signingKey.length < 32 || signingKey.length > 128) invalid('GUARDED_SIGNING_KEY_INVALID');

  const issuer = value.issuer;
  if (typeof issuer !== 'string' || !issuerPattern.test(issuer)) invalid('GUARDED_ISSUER_INVALID');
  const audience = value.audience;
  if (typeof audience !== 'string' || !projectPattern.test(audience)) invalid('GUARDED_AUDIENCE_INVALID');
  if (issuer.slice(issuerPrefix.length) !== audience) invalid('GUARDED_ISSUER_AUDIENCE_MISMATCH');

  const maximumAuthenticationAgeSeconds = value.maximumAuthenticationAgeSeconds;
  if (typeof maximumAuthenticationAgeSeconds !== 'number' || !Number.isSafeInteger(maximumAuthenticationAgeSeconds) ||
      maximumAuthenticationAgeSeconds < 1 || maximumAuthenticationAgeSeconds > 3600) invalid('GUARDED_AUTH_AGE_INVALID');

  const trustedProxyHops = value.trustedProxyHops;
  if (trustedProxyHops !== 0 && trustedProxyHops !== 1) invalid('GUARDED_PROXY_HOPS_INVALID');

  return Object.freeze({ profile: 'guarded-live' as const, origin, host, port, databaseUrl, etagSecret: etagSecret as string,
    cursorSecret: cursorSecret as string, signingKey, issuer, audience, maximumAuthenticationAgeSeconds, trustedProxyHops });
}
