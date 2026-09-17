/** Protected startup material for the reviewed `guarded-live` profile.
 *
 * CQ-003 item 3 asks this profile to validate "protected key persistence". The
 * private synthetic runtime already reads its secrets from a 0600 JSON file with
 * `O_NOFOLLOW` and a size cap (`infra/gcp/runtime/config.mjs:34-44`); this module
 * applies the same rules to the guarded configuration, which is a separate package
 * and therefore cannot import that module. Nothing here activates a provider or
 * starts a host: it only turns a protected file into a validated configuration.
 */
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { validateGuardedConfig, type GuardedRuntimeConfig } from './guarded-config.js';

const maximumBytes = 8192;
const signingKeyPattern = /^[A-Za-z0-9+/]+={0,2}$/;

function invalid(code: string): never {
  throw new Error(code);
}

/** Read one JSON secret from a file that only its owner may read.
 *
 * Rejections are deliberately indistinguishable in their code from "the file
 * could not be read": a caller must not learn whether a protected path exists.
 */
export async function readProtectedSecretJson(path: string): Promise<unknown> {
  let file;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const metadata = await file.stat();
    if (!metadata.isFile() || metadata.size > maximumBytes || (metadata.mode & 0o077) !== 0) invalid('GUARDED_SECRET_FILE_INVALID');
    const buffer = Buffer.alloc(maximumBytes + 1);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > maximumBytes) invalid('GUARDED_SECRET_FILE_INVALID');
    return JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'));
  } catch {
    return invalid('GUARDED_SECRET_FILE_INVALID');
  } finally {
    await file?.close();
  }
}

/** The signing key travels as base64 in the protected file and must decode to a
 * 32-128 byte buffer, matching `validateGuardedConfig`'s rule. Bound first, then
 * decoded, so a huge string cannot be expanded into memory before rejection. */
export function decodeSigningKey(value: unknown): Buffer {
  if (typeof value !== 'string' || value.length > 512 || (value.length & 3) !== 0 || !signingKeyPattern.test(value)) invalid('GUARDED_SIGNING_KEY_INVALID');
  let key: Buffer;
  try {
    key = Buffer.from(value, 'base64');
  } catch {
    return invalid('GUARDED_SIGNING_KEY_INVALID');
  }
  if (key.length < 32 || key.length > 128) invalid('GUARDED_SIGNING_KEY_INVALID');
  // Round-trip check: `Buffer.from(…, 'base64')` ignores characters it dislikes,
  // so a truncated key must not be silently accepted as a shorter key.
  if (key.toString('base64').replace(/=+$/, '') !== value.replace(/=+$/, '')) invalid('GUARDED_SIGNING_KEY_INVALID');
  return key;
}

/** Load and validate the guarded configuration from its protected file. The
 * returned value is the same frozen object `validateGuardedConfig` produces, so a
 * caller cannot mutate the key material after validation. */
export async function loadGuardedConfig(path: string): Promise<GuardedRuntimeConfig> {
  const raw = await readProtectedSecretJson(path);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) invalid('GUARDED_CONFIG_INVALID');
  const value = raw as Record<string, unknown>;
  const signingKey = decodeSigningKey(value.signingKey);
  return validateGuardedConfig({ ...value, signingKey });
}
