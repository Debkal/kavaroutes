import { open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { validateManifest } from './manifest.mjs';

export const schema = 'kavaroutes_cloud_boss';
export const tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
export const riderId = '11111111-1111-4111-8111-111111111112';
export const routes = Object.freeze(['projection', 'realtime-signal']);
// Canonical company scope references. Membership grants persist the same strings;
// a principal holds no scope nobody provisioned.
export const branchScopeReference = `branch:${tenantId}`;
export const fleetScopeReference = `fleet:${tenantId}`;
/** Hard bound on how many enrolled tenants one worker cycle will process. */
export const enrollmentBound = 25;

// Deliberately not a production profile. No provider selection or arbitrary DB host.
export function validateConfig(input) {
  validateManifest();
  if (process.env.NODE_ENV === 'production') throw new Error('PRODUCTION_COMPOSITION_UNAVAILABLE');
  const keys = ['profile', 'databaseUrl', 'etagSecret', 'cursorSecret', 'port'];
  if (!input || typeof input !== 'object' || Array.isArray(input) || keys.some(k => !(k in input)) || Object.keys(input).some(k => !keys.includes(k))) throw new Error('RUNTIME_CONFIG_INVALID');
  if (input.profile !== 'private-synthetic' || !Number.isInteger(input.port) || input.port < 1024 || input.port > 65535) throw new Error('RUNTIME_PROFILE_INVALID');
  let url;
  try { url = new URL(input.databaseUrl); } catch { throw new Error('RUNTIME_DATABASE_INVALID'); }
  if (url.protocol !== 'postgresql:' || url.hostname !== '127.0.0.1' || url.pathname !== '/kavaroutes_cloud' || url.search || url.hash || !url.password ||
      !['kr_cloud_api', 'kr_cloud_worker', 'kr_cloud_admin'].includes(url.username)) throw new Error('RUNTIME_DATABASE_INVALID');
  if (!/^synthetic-etag-secret-[A-Za-z0-9_-]{32,}$/.test(input.etagSecret) || !/^[A-Za-z0-9_-]{43,}$/.test(input.cursorSecret)) throw new Error('RUNTIME_SECRET_INVALID');
  return Object.freeze({ ...input });
}

export async function readSecretJson(path) {
  let file;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const metadata = await file.stat();
    if (!metadata.isFile() || metadata.size > 8192 || (metadata.mode & 0o077)) throw new Error('RUNTIME_SECRET_FILE_INVALID');
    const buffer = Buffer.alloc(8193);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > 8192) throw new Error('RUNTIME_SECRET_FILE_INVALID');
    return JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'));
  } catch { throw new Error('RUNTIME_SECRET_FILE_INVALID'); }
  finally { await file?.close(); }
}

export async function readConfig(path, role) {
  if (process.env.NODE_ENV === 'production') throw new Error('PRODUCTION_COMPOSITION_UNAVAILABLE');
  const input = await readSecretJson(path);
  const config = validateConfig(input);
  if (new URL(config.databaseUrl).username !== `kr_cloud_${role}`) throw new Error('RUNTIME_DATABASE_ROLE_INVALID');
  return config;
}

export function classifyFailure(error) {
  if (['40001', '40P01', '53300'].includes(error?.code)) return 'DATABASE_CONCURRENCY';
  if (['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', '57P01', '08006'].includes(error?.code) || /VERSION_GAP/.test(error?.message ?? '')) return 'TRANSIENT_DEPENDENCY';
  return 'PERMANENT_VALIDATION';
}

export function retryableJob(job) {
  return ['TRANSIENT_DEPENDENCY', 'DATABASE_CONCURRENCY'].includes(job.output?.code) ||
    ['job timed out', 'job heartbeat timeout'].includes(job.output?.value?.message);
}

export function retryDue(job, now = Date.now()) {
  if (!retryableJob(job)) return false;
  return job.retry_count < 7 && now - new Date(job.created_on).getTime() < 86400000 &&
    now - new Date(job.completed_on).getTime() >= Math.min(300, 2 ** (job.retry_count + 1)) * 1000;
}
