import { readFileSync, statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

export function readConfig(path) {
  if (!path) throw new Error('CONFIG_PATH_REQUIRED');
  const info = statSync(path);
  if (process.platform !== 'win32' && (info.mode & 0o077)) throw new Error('CONFIG_REQUIRES_MODE_0600');
  const config = JSON.parse(readFileSync(path, 'utf8'));
  if (!['local','cloudflare'].includes(config.mode)) throw new Error('INVALID_MODE');
  if (!Number.isInteger(config.port) || config.port < 1024 || config.port > 65535) throw new Error('INVALID_PORT');
  const expected = config.mode === 'local' ? `http://127.0.0.1:${config.port}` : 'https://admin.kavaroutes.com';
  if (config.origin !== expected || !isAbsolute(config.database)) throw new Error('INVALID_ORIGIN_OR_DATABASE');
  if (typeof config.encryptionKey !== 'string' || !/^[a-f0-9]{64}$/.test(config.encryptionKey)) throw new Error('INVALID_ENCRYPTION_KEY');
  if (config.mode === 'cloudflare' && (!/^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/.test(config.accessIssuer ?? '') || !/^[a-f0-9]{64}$/.test(config.accessAudience ?? ''))) throw new Error('ACCESS_CONFIGURATION_REQUIRED');
  if (config.email && (config.email.provider!=='gmail' || typeof config.email.enabled!=='boolean' || typeof config.email.from!=='string' || !/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(config.email.from) || !['clientId','clientSecret','refreshToken'].every(key=>typeof config.email[key]==='string'&&config.email[key]))) throw new Error('INVALID_EMAIL_CONFIGURATION');
  return { ...config, database: resolve(config.database), encryptionKey: Buffer.from(config.encryptionKey, 'hex') };
}
