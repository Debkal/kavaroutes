import { createHash, createHmac, createPublicKey, randomBytes, timingSafeEqual, verify, createCipheriv, createDecipheriv } from 'node:crypto';

export const randomToken = () => randomBytes(32).toString('base64url');
export const digest = value => createHash('sha256').update(value).digest('hex');
export function equal(a, b) {
  return typeof a === 'string' && typeof b === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
}
const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function base32(bytes) {
  let bits = 0, value = 0, result = '';
  for (const byte of bytes) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { result += alphabet[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits) result += alphabet[(value << (5 - bits)) & 31];
  return result;
}
export function totp(secret, time = Date.now(), digits = 6) {
  const counter = Buffer.alloc(8); counter.writeBigUInt64BE(BigInt(Math.floor(time / 30_000)));
  const mac = createHmac('sha1', secret).update(counter).digest();
  return String((mac.readUInt32BE(mac.at(-1) & 15) & 0x7fffffff) % 10 ** digits).padStart(digits, '0');
}
export function verifyTotp(secret, code, previous = -1, now = Date.now()) {
  if (typeof code !== 'string' || !/^\d{6}$/.test(code)) return null;
  for (const offset of [0, -1, 1]) {
    const step = Math.floor(now / 30_000) + offset;
    if (step > previous && equal(totp(secret, step * 30_000), code)) return step;
  }
  return null;
}
export function encrypt(secret, key, context) {
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(context));
  return Buffer.concat([iv, cipher.update(secret), cipher.final(), cipher.getAuthTag()]).toString('base64url');
}
export function decrypt(value, key, context) {
  const bytes = Buffer.from(value, 'base64url');
  const cipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
  cipher.setAAD(Buffer.from(context)); cipher.setAuthTag(bytes.subarray(-16));
  return Buffer.concat([cipher.update(bytes.subarray(12, -16)), cipher.final()]);
}
export function publicKey(pem) {
  if (typeof pem !== 'string' || pem.length > 8000 || !pem.startsWith('-----BEGIN PUBLIC KEY-----')) throw new Error('INVALID_PUBLIC_KEY');
  const key = createPublicKey(pem);
  if (key.asymmetricKeyType !== 'ml-dsa-65') throw new Error('ML_DSA_65_REQUIRED');
  return key.export({ format: 'pem', type: 'spki' });
}
export function verifySignature(pem, challenge, signature) {
  if (typeof signature !== 'string' || !/^[A-Za-z0-9_-]{4412}$/.test(signature)) return false;
  try { return verify(null, Buffer.from(challenge), createPublicKey(publicKey(pem)), Buffer.from(signature, 'base64url')); }
  catch { return false; }
}
