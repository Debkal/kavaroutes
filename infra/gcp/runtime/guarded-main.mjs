/** Process entrypoint for the reviewed `guarded-live` profile.
 *
 * Deliberately separate from `main.mjs`, which serves the private synthetic
 * profile: this entry refuses to start unless the reviewed activation marker is
 * present, loads its configuration from a file only its owner can read, and opens
 * the provider SDK only after that loader has accepted the file. All of the
 * ordering lives in `@kavaroutes/api-host/guarded-startup`; this file only supplies
 * the real pool, the real Google identity session and the signal handling.
 *
 * Usage: node infra/gcp/runtime/guarded-main.mjs /run/secrets/guarded-config.json
 *
 * Nothing here deploys, exposes or activates anything by itself: starting it is the
 * human-gated step the queue records as CQ-009.
 */
import { makePool } from './database.mjs';
import { openHostGoogleIdentity } from '@kavaroutes/api-host/google-identity';
import { GUARDED_ACTIVATION_MARKER, startGuardedHost } from '@kavaroutes/api-host/guarded-startup';

let host;
let stopping = false;

/** Which reviewed step the given argument selects, as a fixed label.
 *
 * The launcher's steps are: read the protected configuration file, run the
 * activation hook, open the provider SDK, open the pool, compose the host. When
 * one of them fails the process must say which one, without echoing the path,
 * the configuration or the underlying message (a config/credential error must
 * not be readable from container logs).
 */
function stepOf(path) {
  const value = typeof path === 'string' ? path : '';
  return value === '' ? 'ARGUMENT' : 'CONFIG';
}

async function stop() {
  if (stopping) return;
  stopping = true;
  const deadline = setTimeout(() => process.exit(1), 15000).unref();
  try {
    await host?.shutdown();
  } catch { process.stderr.write('GUARDED_RUNTIME_STOP_FAILED\n'); process.exitCode = 1; }
  finally { clearTimeout(deadline); }
}
/** Only this reviewed constant may appear on stderr; anything else is the fixed
 * fallback. Returning the reviewed code itself (rather than the raw message)
 * keeps an unexpected error from leaking configuration or credential detail. */
function errorCode(error) {
  const message = typeof error?.message === 'string' ? error.message : '';
  return /^[A-Z][A-Z0-9_]{2,63}$/.test(message) ? message : 'GUARDED_RUNTIME_START_FAILED';
}

try {
  const path = process.argv[2];
  if (!path || process.argv.length > 3) throw new Error('GUARDED_ARGUMENTS_INVALID');
  host = await startGuardedHost({
    configPath: path,
    activation: process.env.KAVAROUTES_GUARDED_ACTIVATION ?? '',
    // The marker above is the human activation signal; this hook is where a
    // deployment can add its own approval check before anything is opened.
    activate: async () => {},
    openIdentity: () => openHostGoogleIdentity(async () => {
      if ((process.env.KAVAROUTES_GUARDED_ACTIVATION ?? '') !== GUARDED_ACTIVATION_MARKER) throw new Error('GUARDED_ACTIVATION_REQUIRED');
    }),
    createPool: databaseUrl => makePool({ databaseUrl }, 'kavaroutes-guarded-live'),
  });
  process.once('SIGTERM', () => void stop());
  process.once('SIGINT', () => void stop());
  await host.start();
  // No secrets, digests or tenant detail: the profile name only.
  process.stdout.write('GUARDED_RUNTIME_STARTED_REVIEWED_PROFILE\n');
} catch (error) {
  // The failing configuration step and the reviewed code. `stop()` may add its
  // own code, and nothing else is printed: the message body can name the path,
  // the configuration or the provider state, so it never reaches stderr.
  process.stderr.write(`GUARDED_RUNTIME_START_FAILED:${stepOf(process.argv[2])}\n`);
  process.stderr.write(`${errorCode(error)}\n`);
  await stop();
  process.exitCode = 1;
}
