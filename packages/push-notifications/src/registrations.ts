import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from "node:crypto";

export const PUSH_PLATFORMS = ["ios", "android"] as const;
export const PUSH_PROVIDERS = ["apns", "fcm"] as const;
export type PushPlatform = typeof PUSH_PLATFORMS[number];
export type PushProvider = typeof PUSH_PROVIDERS[number];
export type RegistrationPermission = "not_requested" | "provisional" | "granted" | "denied" | "channel_limited" | "system_disabled";
export type RegistrationInactiveReason = "logout" | "deprovisioned" | "principal_switched" | "tenant_switched" | "installation_replaced" | "provider_invalid" | "remote_revocation" | "stale";

export interface RegistrationInput {
  readonly organizationId: string;
  readonly principalId: string;
  readonly subjectId: string;
  readonly installationId: string;
  readonly generation: string;
  readonly platform: PushPlatform;
  readonly provider: PushProvider;
  readonly environment: "sandbox" | "development";
  readonly appId: string;
  readonly token: string;
  readonly permission: RegistrationPermission;
  readonly channelEnabled: boolean;
  readonly policyVersion: "push.policy.v1";
}

export interface RegistrationView {
  readonly organizationId: string;
  readonly principalId: string;
  readonly subjectId: string;
  readonly installationId: string;
  readonly generation: string;
  readonly platform: PushPlatform;
  readonly provider: PushProvider;
  readonly environment: "sandbox" | "development";
  readonly appId: string;
  readonly permission: RegistrationPermission;
  readonly channelEnabled: boolean;
  readonly policyVersion: "push.policy.v1";
  readonly lifecycle: "active" | "inactive";
  readonly inactiveReason?: RegistrationInactiveReason;
  readonly createdAt: string;
  readonly refreshedAt: string;
  readonly lastConfirmedAt: string;
  readonly tokenFingerprint: string;
}

interface StoredRegistration extends RegistrationView {
  readonly sealedToken: string;
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const generation = /^gen_[a-z0-9_-]{12,96}$/;
const appId = /^(?:com\.)?kavaroutes\.[a-z0-9.-]{3,80}$/;
const idempotency = /^[A-Za-z0-9_-]{16,128}$/;

function fingerprint(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }

export function createTokenVault(input: { readonly encryptionKey: Uint8Array; readonly equalityKey: Uint8Array; readonly ivFactory?: () => Uint8Array }) {
  if (input.encryptionKey.byteLength !== 32 || input.equalityKey.byteLength < 32) throw new Error("PUSH_TOKEN_KEY_INVALID");
  const ivFactory = input.ivFactory ?? (() => randomBytes(12));
  return Object.freeze({
    seal(token: string) {
      if (token.length < 16 || token.length > 4096 || /\s/.test(token)) throw new Error("PUSH_TOKEN_INVALID");
      const iv = Buffer.from(ivFactory()); if (iv.byteLength !== 12) throw new Error("PUSH_TOKEN_IV_INVALID");
      const cipher = createCipheriv("aes-256-gcm", input.encryptionKey, iv);
      const ciphertext = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
      return `${iv.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}.${ciphertext.toString("base64url")}`;
    },
    open(sealed: string) {
      const parts = sealed.split("."); if (parts.length !== 3) throw new Error("PUSH_TOKEN_CIPHERTEXT_INVALID");
      const [ivPart, tagPart, ciphertextPart] = parts; if (!ivPart || !tagPart || !ciphertextPart) throw new Error("PUSH_TOKEN_CIPHERTEXT_INVALID");
      const decipher = createDecipheriv("aes-256-gcm", input.encryptionKey, Buffer.from(ivPart, "base64url"));
      decipher.setAuthTag(Buffer.from(tagPart, "base64url"));
      return Buffer.concat([decipher.update(Buffer.from(ciphertextPart, "base64url")), decipher.final()]).toString("utf8");
    },
    hash(token: string) { return createHmac("sha256", input.equalityKey).update(token).digest("hex"); },
  });
}

function publicView(value: StoredRegistration): RegistrationView {
  const { sealedToken: _sealedToken, ...view } = value;
  return Object.freeze(view);
}

function validate(input: RegistrationInput): void {
  if (![input.organizationId, input.principalId, input.subjectId, input.installationId].every((value) => uuid.test(value))) throw new Error("PUSH_REGISTRATION_ID_INVALID");
  if (!generation.test(input.generation) || !appId.test(input.appId)) throw new Error("PUSH_REGISTRATION_BINDING_INVALID");
  if ((input.platform === "ios") !== (input.provider === "apns")) throw new Error("PUSH_PROVIDER_PLATFORM_MISMATCH");
  if (input.token.length < 16 || input.token.length > 4096 || /\s/.test(input.token)) throw new Error("PUSH_TOKEN_INVALID");
}

export function createRegistrationService(options: { readonly vault: ReturnType<typeof createTokenVault>; readonly now?: () => Date }) {
  const now = options.now ?? (() => new Date());
  const registrations = new Map<string, StoredRegistration>();
  const requests = new Map<string, { readonly fingerprint: string; readonly result: RegistrationView }>();
  return Object.freeze({
    register(context: { readonly organizationId: string; readonly principalId: string; readonly subjectId: string; readonly idempotencyKey: string }, input: RegistrationInput): RegistrationView {
      if (!idempotency.test(context.idempotencyKey)) throw new Error("PUSH_IDEMPOTENCY_KEY_INVALID");
      if (context.organizationId !== input.organizationId || context.principalId !== input.principalId || context.subjectId !== input.subjectId) throw new Error("PUSH_REGISTRATION_CONTEXT_MISMATCH");
      validate(input);
      const requestKey = `${context.organizationId}:${context.principalId}:${context.idempotencyKey}`;
      const requestFingerprint = fingerprint(input);
      const replay = requests.get(requestKey);
      if (replay) { if (replay.fingerprint !== requestFingerprint) throw new Error("PUSH_IDEMPOTENCY_MISMATCH"); return replay.result; }
      const timestamp = now().toISOString();
      for (const [key, current] of registrations) {
        if (current.organizationId === input.organizationId && current.principalId === input.principalId && current.installationId === input.installationId && current.lifecycle === "active" && current.generation !== input.generation) {
          registrations.set(key, { ...current, lifecycle: "inactive", inactiveReason: "installation_replaced", refreshedAt: timestamp });
        }
      }
      const key = `${input.organizationId}:${input.installationId}:${input.generation}`;
      const previous = registrations.get(key);
      const stored: StoredRegistration = Object.freeze({
        organizationId: input.organizationId, principalId: input.principalId, subjectId: input.subjectId,
        installationId: input.installationId, generation: input.generation, platform: input.platform, provider: input.provider,
        environment: input.environment, appId: input.appId, permission: input.permission, channelEnabled: input.channelEnabled,
        policyVersion: "push.policy.v1", lifecycle: "active", createdAt: previous?.createdAt ?? timestamp, refreshedAt: timestamp,
        lastConfirmedAt: timestamp, tokenFingerprint: options.vault.hash(input.token), sealedToken: options.vault.seal(input.token),
      });
      registrations.set(key, stored);
      const result = publicView(stored); requests.set(requestKey, { fingerprint: requestFingerprint, result }); return result;
    },
    unregister(context: { readonly organizationId: string; readonly principalId: string; readonly subjectId: string }, input: { readonly installationId: string; readonly generation: string; readonly reason: RegistrationInactiveReason }): RegistrationView {
      const key = `${context.organizationId}:${input.installationId}:${input.generation}`; const found = registrations.get(key);
      if (!found || found.principalId !== context.principalId || found.subjectId !== context.subjectId) throw new Error("PUSH_REGISTRATION_NOT_FOUND");
      const updated: StoredRegistration = Object.freeze({ ...found, lifecycle: "inactive", inactiveReason: input.reason, refreshedAt: now().toISOString() });
      registrations.set(key, updated); return publicView(updated);
    },
    activeFor(organizationId: string, principalId: string): readonly RegistrationView[] {
      return [...registrations.values()].filter((value) => value.organizationId === organizationId && value.principalId === principalId && value.lifecycle === "active").map(publicView);
    },
    tokenFor(organizationId: string, installationId: string, generationValue: string): string {
      const found = registrations.get(`${organizationId}:${installationId}:${generationValue}`);
      if (!found || found.lifecycle !== "active") throw new Error("PUSH_REGISTRATION_NOT_ACTIVE");
      return options.vault.open(found.sealedToken);
    },
    retireStale(olderThan: Date): number {
      let retired = 0; const timestamp = now().toISOString();
      for (const [key, current] of registrations) if (current.lifecycle === "active" && Date.parse(current.lastConfirmedAt) < olderThan.getTime()) {
        registrations.set(key, { ...current, lifecycle: "inactive", inactiveReason: "stale", refreshedAt: timestamp }); retired += 1;
      }
      return retired;
    },
  });
}
