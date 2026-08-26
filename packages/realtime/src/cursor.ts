import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { REALTIME_POLICY_VERSION, REALTIME_PROJECTION_VERSION, REALTIME_PROTOCOL, REALTIME_SCHEMA_VERSION, type NormalizedScope, type SubscriptionPurpose } from "./contracts.js";

export interface CursorVector {
  readonly streamId: string;
  readonly epoch: number;
  readonly sequence: number;
}

export interface RealtimeCursorClaims {
  readonly protocol: typeof REALTIME_PROTOCOL;
  readonly organizationId: string;
  readonly principalId: string;
  readonly authorizationGeneration: number;
  readonly purpose: SubscriptionPurpose;
  readonly scope: NormalizedScope;
  readonly projectionVersion: typeof REALTIME_PROJECTION_VERSION;
  readonly schemaVersion: typeof REALTIME_SCHEMA_VERSION;
  readonly policyVersion: typeof REALTIME_POLICY_VERSION;
  readonly vectors: readonly CursorVector[];
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly keyVersion: string;
}

export interface CursorBinding {
  readonly organizationId: string;
  readonly principalId: string;
  readonly authorizationGeneration: number;
  readonly purpose: SubscriptionPurpose;
  readonly scope: NormalizedScope;
}

export class CursorRejected extends Error {
  constructor(readonly reason: "MALFORMED" | "TAMPERED" | "BINDING_MISMATCH" | "EXPIRED" | "VERSION_MISMATCH" | "KEY_VERSION_UNKNOWN") {
    super("CURSOR_REJECTED");
    this.name = "CursorRejected";
  }
}

function base64Url(buffer: Buffer): string {
  return buffer.toString("base64url");
}

function canonicalScope(scope: NormalizedScope): string {
  return JSON.stringify(Object.fromEntries(Object.entries(scope).sort(([left], [right]) => left.localeCompare(right))));
}

function stringEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function createTestOnlyCursorCodec(options: {
  readonly keyReference?: string;
  readonly secret?: string;
  readonly now?: () => Date;
  readonly nonceFactory?: () => Buffer;
} = {}) {
  const keyVersion = options.keyReference ?? "test-only-key-v1";
  const key = createHash("sha256").update(options.secret ?? "KAVAROUTES_SYNTHETIC_WP009_CURSOR_KEY_NOT_FOR_PRODUCTION").digest();
  const now = options.now ?? (() => new Date());
  const nonceFactory = options.nonceFactory ?? (() => randomBytes(12));
  const aad = Buffer.from(`${REALTIME_PROTOCOL}:${keyVersion}`);

  function encode(input: Omit<RealtimeCursorClaims, "protocol" | "projectionVersion" | "schemaVersion" | "policyVersion" | "issuedAt" | "expiresAt" | "keyVersion"> & { readonly lifetimeMilliseconds: number }): string {
    if (!Number.isInteger(input.lifetimeMilliseconds) || input.lifetimeMilliseconds < 1 || input.lifetimeMilliseconds > 7 * 24 * 60 * 60 * 1000) throw new Error("CURSOR_LIFETIME_INVALID");
    const issued = now();
    const claims: RealtimeCursorClaims = {
      protocol: REALTIME_PROTOCOL,
      organizationId: input.organizationId,
      principalId: input.principalId,
      authorizationGeneration: input.authorizationGeneration,
      purpose: input.purpose,
      scope: input.scope,
      projectionVersion: REALTIME_PROJECTION_VERSION,
      schemaVersion: REALTIME_SCHEMA_VERSION,
      policyVersion: REALTIME_POLICY_VERSION,
      vectors: [...input.vectors].sort((left, right) => left.streamId.localeCompare(right.streamId)),
      issuedAt: issued.toISOString(),
      expiresAt: new Date(issued.getTime() + input.lifetimeMilliseconds).toISOString(),
      keyVersion,
    };
    const nonce = nonceFactory();
    if (nonce.length !== 12) throw new Error("CURSOR_NONCE_INVALID");
    const cipher = createCipheriv("aes-256-gcm", key, nonce);
    cipher.setAAD(aad);
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(claims), "utf8"), cipher.final()]);
    return `rtc1.${base64Url(Buffer.concat([Buffer.from([keyVersion.length]), Buffer.from(keyVersion), nonce, cipher.getAuthTag(), encrypted]))}`;
  }

  function decode(token: string, binding: CursorBinding): RealtimeCursorClaims {
    if (typeof token !== "string" || !token.startsWith("rtc1.") || token.length > 8197) throw new CursorRejected("MALFORMED");
    let packed: Buffer;
    try { packed = Buffer.from(token.slice(5), "base64url"); }
    catch { throw new CursorRejected("MALFORMED"); }
    const versionLength = packed[0] ?? 0;
    if (versionLength < 1 || packed.length < 1 + versionLength + 12 + 16 + 2) throw new CursorRejected("MALFORMED");
    const encodedKeyVersion = packed.subarray(1, 1 + versionLength).toString("utf8");
    if (!stringEqual(encodedKeyVersion, keyVersion)) throw new CursorRejected("KEY_VERSION_UNKNOWN");
    const nonceStart = 1 + versionLength;
    const nonce = packed.subarray(nonceStart, nonceStart + 12);
    const tag = packed.subarray(nonceStart + 12, nonceStart + 28);
    const encrypted = packed.subarray(nonceStart + 28);
    let claims: RealtimeCursorClaims;
    try {
      const decipher = createDecipheriv("aes-256-gcm", key, nonce);
      decipher.setAAD(aad);
      decipher.setAuthTag(tag);
      claims = JSON.parse(Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8")) as RealtimeCursorClaims;
    } catch { throw new CursorRejected("TAMPERED"); }
    if (claims.protocol !== REALTIME_PROTOCOL || claims.projectionVersion !== REALTIME_PROJECTION_VERSION || claims.schemaVersion !== REALTIME_SCHEMA_VERSION || claims.policyVersion !== REALTIME_POLICY_VERSION || claims.keyVersion !== keyVersion) throw new CursorRejected("VERSION_MISMATCH");
    if (!stringEqual(claims.organizationId, binding.organizationId) || !stringEqual(claims.principalId, binding.principalId) || claims.authorizationGeneration !== binding.authorizationGeneration || claims.purpose !== binding.purpose || !stringEqual(canonicalScope(claims.scope), canonicalScope(binding.scope))) throw new CursorRejected("BINDING_MISMATCH");
    if (!Number.isFinite(Date.parse(claims.expiresAt)) || Date.parse(claims.expiresAt) <= now().getTime()) throw new CursorRejected("EXPIRED");
    if (!Array.isArray(claims.vectors) || claims.vectors.some((vector) => typeof vector.streamId !== "string" || !Number.isInteger(vector.epoch) || vector.epoch < 1 || !Number.isInteger(vector.sequence) || vector.sequence < 0)) throw new CursorRejected("MALFORMED");
    return Object.freeze({ ...claims, vectors: Object.freeze(claims.vectors.map((vector) => Object.freeze({ ...vector }))) });
  }

  return Object.freeze({ encode, decode, keyReference: keyVersion, productionReady: false as const });
}

export type TestOnlyCursorCodec = ReturnType<typeof createTestOnlyCursorCodec>;
