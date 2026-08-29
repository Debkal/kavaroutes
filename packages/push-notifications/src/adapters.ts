import { createSign } from "node:crypto";
import { assertProviderBoundaryEnvelope } from "./contracts.js";
import type { PushPort, PushResult, PushTarget } from "./delivery.js";
import type { DeliveryInstruction } from "./policy.js";

interface TransportResponse { readonly status: number; readonly safeReason?: string; readonly retryAfterSeconds?: number; }
export interface ProviderTransport { exchange(request: { readonly endpoint: string; readonly headers: Readonly<Record<string, string>>; readonly body: string }): Promise<TransportResponse>; }

const permanent = (safeCode: string): PushResult => Object.freeze({ outcome: "permanent_payload_or_auth", safeCode });
const classify = (provider: "apns" | "fcm", response: TransportResponse): PushResult => {
  if (response.status >= 200 && response.status < 300) return Object.freeze({ outcome: "accepted", safeCode: "PROVIDER_ACCEPTED" });
  if (provider === "apns" && (response.status === 410 || (response.status === 400 && ["BadDeviceToken", "DeviceTokenNotForTopic"].includes(response.safeReason ?? "")))) return Object.freeze({ outcome: "invalid_registration", safeCode: "REGISTRATION_INVALID" });
  if (provider === "fcm" && response.status === 404 && response.safeReason === "UNREGISTERED") return Object.freeze({ outcome: "invalid_registration", safeCode: "REGISTRATION_INVALID" });
  if (response.status === 429) return Object.freeze({ outcome: "throttled", safeCode: "PROVIDER_THROTTLED", ...(response.retryAfterSeconds === undefined ? {} : { retryAfterSeconds: response.retryAfterSeconds }) });
  if (response.status >= 500) return Object.freeze({ outcome: "transient_provider", safeCode: "PROVIDER_TRANSIENT" });
  return permanent("PROVIDER_PERMANENT_REJECTION");
};

function apnsBody(instruction: DeliveryInstruction): string {
  const aps = instruction.visible
    ? { alert: { title: instruction.title, body: instruction.body } }
    : { "content-available": 1 };
  return JSON.stringify({ aps, ...assertProviderBoundaryEnvelope(instruction.envelope) });
}

export function createDirectApnsPort(options: { readonly configured: boolean; readonly topic: string; readonly authorization: () => Promise<string>; readonly transport: ProviderTransport; readonly now?: () => Date }): PushPort {
  return Object.freeze({ async send(target: PushTarget, instruction: DeliveryInstruction) {
    if (!options.configured) throw new Error("APNS_PROVIDER_NOT_CONFIGURED_HIG_013_REQUIRED");
    if (target.provider !== "apns" || target.platform !== "ios" || target.environment !== "sandbox" || target.appId !== options.topic) return permanent("APNS_TARGET_POLICY_INVALID");
    const expiration = Math.floor(Date.parse(instruction.expiresAt) / 1000);
    const response = await options.transport.exchange({ endpoint: `https://api.sandbox.push.apple.com/3/device/${target.token}`,
      headers: { authorization: `bearer ${await options.authorization()}`, "apns-topic": options.topic, "apns-push-type": instruction.visible ? "alert" : "background",
        "apns-priority": instruction.visible ? "10" : "5", "apns-expiration": String(expiration), "apns-collapse-id": instruction.collapseClass }, body: apnsBody(instruction) });
    return classify("apns", response);
  } });
}

const base64url = (value: string | Uint8Array) => Buffer.from(value).toString("base64url");

export function createApnsTokenAuthorization(options: { readonly teamId: string; readonly keyId: string; readonly privateKey: string; readonly now?: () => Date }) {
  if (!/^[A-Z0-9]{10}$/.test(options.teamId) || !/^[A-Z0-9]{10}$/.test(options.keyId) || !/^-----BEGIN PRIVATE KEY-----/.test(options.privateKey)) throw new Error("APNS_AUTH_CONFIGURATION_INVALID");
  const now = options.now ?? (() => new Date()); let cached: { readonly value: string; readonly issuedAt: number } | undefined;
  return Object.freeze({
    async token() {
      const seconds = Math.floor(now().getTime() / 1000);
      if (cached && seconds - cached.issuedAt < 1_200) return cached.value;
      const header = base64url(JSON.stringify({ alg: "ES256", kid: options.keyId }));
      const claims = base64url(JSON.stringify({ iss: options.teamId, iat: seconds })); const signingInput = `${header}.${claims}`;
      const signature = createSign("SHA256").update(signingInput).end().sign({ key: options.privateKey, dsaEncoding: "ieee-p1363" });
      const value = `${signingInput}.${base64url(signature)}`; cached = { value, issuedAt: seconds }; return value;
    },
  });
}

function fcmBody(target: PushTarget, instruction: DeliveryInstruction): string {
  const message: Record<string, unknown> = { token: target.token, data: assertProviderBoundaryEnvelope(instruction.envelope), android: {
    priority: instruction.visible ? "high" : "normal", ttl: "300s", collapse_key: instruction.collapseClass,
    ...(instruction.visible ? { notification: { channel_id: "dispatch_updates", title: instruction.title, body: instruction.body, default_sound: false } } : {}),
  } };
  return JSON.stringify({ message });
}

export function createDirectFcmPort(options: { readonly configured: boolean; readonly projectReference: string; readonly oauth: { readonly scope: "https://www.googleapis.com/auth/firebase.messaging"; token(): Promise<string> }; readonly transport: ProviderTransport }): PushPort {
  return Object.freeze({ async send(target: PushTarget, instruction: DeliveryInstruction) {
    if (!options.configured) throw new Error("FCM_PROVIDER_NOT_CONFIGURED_HIG_013_REQUIRED");
    if (target.provider !== "fcm" || target.platform !== "android" || target.environment !== "development") return permanent("FCM_TARGET_POLICY_INVALID");
    const response = await options.transport.exchange({ endpoint: `https://fcm.googleapis.com/v1/projects/${options.projectReference}/messages:send`,
      headers: { authorization: `Bearer ${await options.oauth.token()}`, "content-type": "application/json; charset=UTF-8" }, body: fcmBody(target, instruction) });
    return classify("fcm", response);
  } });
}
